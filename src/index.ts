import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { HyperMCPConfig } from "./config/types.ts";
import { resolveEnvironmentReferences } from "./config/environment.ts";
import { HyperMCPRuntime } from "./core/runtime.ts";
import { installClientConfig, resolveClientConfigTarget, type McpClient } from "./cli/clientConfig.ts";
import { parseReviewArguments, runReview } from "./cli/review.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

const SnapshotPlanSchema = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  restoreTool: z.string().min(1),
  restoreArgumentKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
});

const SQLiteOccPlanSchema = z.object({
  readTool: z.string().min(1),
  writeTool: z.string().min(1),
  readArgumentKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).default("query"),
  writeArgumentKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).default("query"),
  tables: z.array(z.object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    primaryKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    allowedColumns: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)),
  })).min(1),
});

const ServerConfigSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  transport: z.enum(["stdio", "streamable-http", "sse"]).default("stdio"),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  readOnlyTools: z.array(z.string().min(1)).default([]),
  stagedTools: z.record(z.string().min(1), SnapshotPlanSchema).default({}),
  sqliteOcc: SQLiteOccPlanSchema.optional(),
  internalTools: z.array(z.string().min(1)).default([]),
  secretHydrationTools: z.array(z.string().min(1)).default([]),
}).superRefine((server, context) => {
  if (server.transport === "stdio" && !server.command) context.addIssue({ code: "custom", path: ["command"], message: "stdio servers require a command" });
  if (server.transport !== "stdio" && !server.url) context.addIssue({ code: "custom", path: ["url"], message: "HTTP servers require a URL" });
  if (server.transport !== "stdio" && server.url) {
    const url = new URL(server.url);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) context.addIssue({ code: "custom", path: ["url"], message: "remote MCP URLs must use HTTPS" });
    if (url.username || url.password) context.addIssue({ code: "custom", path: ["url"], message: "credentials must be sent in headers, not embedded in the URL" });
  }
  const declared = [...server.readOnlyTools, ...Object.keys(server.stagedTools), ...server.internalTools, ...(server.sqliteOcc ? [server.sqliteOcc.writeTool] : [])];
  if (new Set(declared).size !== declared.length) context.addIssue({ code: "custom", message: "tool policy entries must be unique and non-overlapping" });
  if (server.sqliteOcc) {
    if (server.sqliteOcc.readTool === server.sqliteOcc.writeTool) context.addIssue({ code: "custom", path: ["sqliteOcc"], message: "SQLite OCC readTool and writeTool must be different tools" });
    if (!server.readOnlyTools.includes(server.sqliteOcc.readTool)) context.addIssue({ code: "custom", path: ["sqliteOcc", "readTool"], message: "SQLite OCC readTool must be explicitly listed in readOnlyTools" });
    const tables = server.sqliteOcc.tables.map((table) => table.name.toLocaleLowerCase("en-US"));
    if (new Set(tables).size !== tables.length) context.addIssue({ code: "custom", path: ["sqliteOcc", "tables"], message: "SQLite OCC table names must be unique" });
    for (const [index, table] of server.sqliteOcc.tables.entries()) {
      const columns = table.allowedColumns.map((column) => column.toLocaleLowerCase("en-US"));
      if (new Set(columns).size !== columns.length) context.addIssue({ code: "custom", path: ["sqliteOcc", "tables", index, "allowedColumns"], message: "allowedColumns must be unique" });
      if (columns.includes(table.primaryKey.toLocaleLowerCase("en-US"))) context.addIssue({ code: "custom", path: ["sqliteOcc", "tables", index, "allowedColumns"], message: "the key column cannot be writable" });
    }
  }
  for (const [tool, plan] of Object.entries(server.stagedTools)) {
    if (tool === plan.tool || tool === plan.restoreTool) context.addIssue({ code: "custom", path: ["stagedTools", tool], message: "a staged tool cannot be its own snapshot or restore tool" });
    if (!server.internalTools.includes(plan.restoreTool)) context.addIssue({ code: "custom", path: ["stagedTools", tool], message: "restoreTool must also be declared in internalTools" });
  }
  for (const tool of server.secretHydrationTools) {
    if (!Object.hasOwn(server.stagedTools, tool)) context.addIssue({ code: "custom", path: ["secretHydrationTools"], message: tool + " must be staged for human approval" });
  }
});

const ConfigSchema = z.object({
  dashboardPort: z.number().int().min(0).max(65535).default(4317),
  lockFile: z.string().min(1).default("./mcp-lock.json"),
  policies: z.object({
    virtualizeThresholdTokens: z.number().int().min(50).max(100_000).default(500),
    searchLimit: z.number().int().min(1).max(50).default(5),
    maskEmails: z.boolean().default(true),
    snapshotRetentionHours: z.number().int().min(0).max(720).default(0),
    maxSnapshotStorageMb: z.number().int().min(10).max(2048).default(50),
  }).default({ virtualizeThresholdTokens: 500, searchLimit: 5, maskEmails: true, snapshotRetentionHours: 0, maxSnapshotStorageMb: 50 }),
  servers: z.array(ServerConfigSchema).min(1),
}).superRefine((config, context) => {
  if (new Set(config.servers.map((server) => server.name)).size !== config.servers.length) context.addIssue({ code: "custom", path: ["servers"], message: "server names must be unique" });
});

async function loadConfig(filePath?: string): Promise<HyperMCPConfig> {
  const absoluteConfigPath = path.resolve(filePath ?? "hypermcp.config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("No HyperMCP config found. Run `hypermcp init`, then edit hypermcp.config.json and start with `hypermcp start --config hypermcp.config.json`.");
    throw error;
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid HyperMCP config:\n" + parsed.error.issues.map((issue) => "- " + ["config", ...issue.path].join(".") + ": " + issue.message).join("\n"));
  const root = path.dirname(absoluteConfigPath);
  return {
    ...parsed.data,
    lockFile: path.resolve(root, parsed.data.lockFile),
    servers: parsed.data.servers.map((server) => ({
      ...server,
      cwd: path.resolve(root, server.cwd ?? "."),
      ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, resolveEnvironmentReferences(value, server.name + ".env." + key)])) } : {}),
      ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, resolveEnvironmentReferences(value, server.name + ".headers." + key)])) } : {}),
    })),
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function runtimeEntrypoint(): string {
  return import.meta.url.endsWith(".ts")
    ? path.resolve(here, "../dist/index.js")
    : path.join(here, "index.js");
}

function clientServerEntry(configPath: string): Record<string, unknown> {
  return {
    command: process.execPath,
    args: ["--experimental-sqlite", runtimeEntrypoint(), "start", "--config", configPath],
  };
}

async function startCommand(config: HyperMCPConfig): Promise<void> {
  const runtime = new HyperMCPRuntime(config);
  let server: ReturnType<HyperMCPRuntime["createMcpServer"]> | undefined;
  let transport: StdioServerTransport | undefined;
  try {
    await runtime.start();
    server = runtime.createMcpServer();
    transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    await server?.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    throw error;
  }
  console.error("HyperMCP listening over stdio. Dashboard: " + runtime.dashboardUrl);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server?.close().catch(() => undefined);
    await runtime.close().catch((error) => console.error("HyperMCP shutdown error:", error));
  };
  transport.onclose = () => { void shutdown(); };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

async function wrapCommand(configArg?: string): Promise<void> {
  const configPath = path.resolve(configArg ?? "hypermcp.config.json");
  await loadConfig(configPath);
  const output = {
    mcpServers: {
      hypermcp: clientServerEntry(configPath),
    },
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

async function installCommand(args: string[]): Promise<void> {
  const client = args[0] as McpClient | undefined;
  if (!client || !["claude", "cursor", "windsurf"].includes(client)) {
    throw new Error("Usage: hypermcp install <claude|cursor|windsurf> [--config path] [--project] [--client-config path] [--replace]");
  }
  let configArg: string | undefined;
  let clientConfigArg: string | undefined;
  let project = false;
  let replace = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project") {
      project = true;
    } else if (argument === "--replace") {
      replace = true;
    } else if (argument === "--config") {
      if (configArg || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--config requires one path and may be used only once.");
      configArg = args[index + 1];
      index += 1;
    } else if (argument === "--client-config") {
      if (clientConfigArg || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--client-config requires one path and may be used only once.");
      clientConfigArg = args[index + 1];
      index += 1;
    } else {
      throw new Error("Unknown install option: " + argument);
    }
  }
  if (project && client !== "cursor") throw new Error("--project is currently supported only for Cursor.");
  if (project && clientConfigArg) throw new Error("Use either --project or --client-config, not both.");

  const configPath = path.resolve(configArg ?? "hypermcp.config.json");
  await loadConfig(configPath);
  const entrypoint = runtimeEntrypoint();
  if (!path.isAbsolute(entrypoint) || !(await stat(entrypoint).then((info) => info.isFile()).catch(() => false))) {
    throw new Error("Built HyperMCP entrypoint is missing. Run `npm run build` before installing it in a client.");
  }

  const target = clientConfigArg
    ? path.resolve(clientConfigArg)
    : await resolveClientConfigTarget(client, { project, cwd: process.cwd() });
  const result = await installClientConfig({
    configPath: target,
    serverName: "hypermcp",
    server: clientServerEntry(configPath),
    replace,
  });
  if (!result.changed) {
    process.stdout.write("HyperMCP is already configured in " + result.configPath + ". Restart or refresh the MCP client if it is not visible.\n");
    return;
  }
  process.stdout.write("Installed HyperMCP in " + result.configPath + ". Restart or refresh the MCP client to load it.\n");
  if (result.backupPath) process.stdout.write("Backup: " + result.backupPath + "\n");
}

async function doctorCommand(configArg?: string): Promise<void> {
  const configPath = path.resolve(configArg ?? "hypermcp.config.json");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error("HyperMCP requires Node.js 22.5 or newer; found " + process.versions.node + ".");
  }
  const config = await loadConfig(configPath);
  for (const server of config.servers) {
    if (!(await stat(server.cwd ?? process.cwd()).then((info) => info.isDirectory()).catch(() => false))) {
      throw new Error("Configured working directory does not exist for upstream '" + server.name + "': " + server.cwd);
    }
  }
  const entrypoint = runtimeEntrypoint();
  if (!(await stat(entrypoint).then((info) => info.isFile()).catch(() => false))) {
    throw new Error("Built HyperMCP entrypoint is missing. Run `npm run build` before starting the client.");
  }

  const diagnosticsDirectory = await mkdtemp(path.join(path.dirname(configPath), ".hypermcp-doctor-"));
  const runtimeConfig = { ...config, lockFile: path.join(diagnosticsDirectory, "mcp-lock.json") };
  try {
    try {
      await copyFile(config.lockFile, runtimeConfig.lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const runtime = new HyperMCPRuntime(runtimeConfig, { journalPath: path.join(diagnosticsDirectory, "audit.sqlite") });
    let mcpServer: ReturnType<HyperMCPRuntime["createMcpServer"]> | undefined;
    let client: Client | undefined;
    try {
      await runtime.start({ dashboard: false });
      mcpServer = runtime.createMcpServer();
      client = new Client({ name: "hypermcp-doctor", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      if (tools.length !== 5) throw new Error("MCP handshake returned " + tools.length + " HyperMCP tools; expected 5.");
      const security = (runtime.getDashboardState() as { security: { pinnedTools: number; blockedTools: number } }).security;
      process.stdout.write(JSON.stringify({
        status: security.blockedTools ? "warning" : "healthy",
        node: process.versions.node,
        config: configPath,
        runtime: "built entrypoint found",
        mcp_tool_surface: "tool listing handshake passed",
        meta_tools: tools.map((tool) => tool.name),
        upstream_connections: config.servers.map((server) => ({
          name: server.name,
          transport: server.transport ?? "stdio",
          status: "connected",
        })),
        schema_lock: {
          configured_path: config.lockFile,
          pinned_tools: security.pinnedTools,
          blocked_tools: security.blockedTools,
          note: "checked using a temporary copy; configured lock file was not changed",
        },
      }, null, 2) + "\n");
      if (security.blockedTools) process.exitCode = 1;
    } finally {
      await client?.close().catch(() => undefined);
      await mcpServer?.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
    }
  } catch (error) {
    throw new Error("Doctor could not complete the MCP stdio check: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    await rm(diagnosticsDirectory, { recursive: true, force: true });
  }
}

async function reviewCommand(args: string[]): Promise<void> {
  const options = parseReviewArguments(args);
  let port = options.port;
  if (port === undefined && options.configPath) port = (await loadConfig(options.configPath)).dashboardPort;
  if (port === 0) throw new Error("The configured dashboard uses an ephemeral port. Pass its printed port with `hypermcp review --port <number>`.");
  await runReview({ port: port ?? 4317 });
}

async function verifyCommand(config: HyperMCPConfig): Promise<void> {
  const diagnosticsDirectory = await mkdtemp(path.join(tmpdir(), "hypermcp-verify-"));
  const runtime = new HyperMCPRuntime(config, { journalPath: path.join(diagnosticsDirectory, "audit.sqlite") });
  let mcpServer: ReturnType<HyperMCPRuntime["createMcpServer"]> | undefined;
  let client: Client | undefined;
  try {
    await runtime.start({ dashboard: false });
    mcpServer = runtime.createMcpServer();
    client = new Client({ name: "hypermcp-verify", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    process.stdout.write(JSON.stringify({
      status: tools.length === 5 ? "verified" : "invalid-meta-tool-count",
      meta_tools: tools.map((tool) => tool.name),
      connected_upstreams: config.servers.map((server) => server.name),
    }, null, 2) + "\n");
    if (tools.length !== 5) process.exitCode = 1;
  } finally {
    await client?.close().catch(() => undefined);
    await mcpServer?.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await rm(diagnosticsDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "start";
  if (command === "init") {
    const target = path.resolve("hypermcp.config.json");
    await copyFile(path.join(here, "../hypermcp.config.example.json"), target, fsConstants.COPYFILE_EXCL);
    process.stdout.write("Created " + target + ". Add your upstream MCP servers and tool policies before starting HyperMCP.\n");
    return;
  }
  if (command === "wrap") return wrapCommand(optionValue(args, "--config"));
  if (command === "install") return installCommand(args.slice(1));
  if (command === "doctor") return doctorCommand(optionValue(args, "--config"));
  if (command === "review") return reviewCommand(args.slice(1));
  const config = await loadConfig(optionValue(args, "--config"));
  if (command === "verify") return verifyCommand(config);
  if (command === "start") return startCommand(config);
  throw new Error("Unknown command: " + command + ". Usage: hypermcp <init|start|wrap|verify|install|doctor|review> [options]");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
