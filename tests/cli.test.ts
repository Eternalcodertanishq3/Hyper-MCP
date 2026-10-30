import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { installClientConfig, resolveClientConfigPath, resolveClientConfigTarget } from "../src/cli/clientConfig.ts";
import { parseReviewArguments, ReviewApiClient } from "../src/cli/review.ts";

const execFileAsync = promisify(execFile);

test("review options accept a port and config path without permitting invalid dashboard targets", () => {
  assert.deepEqual(parseReviewArguments(["--config", "./hypermcp.config.json", "--port", "4318"]), {
    configPath: "./hypermcp.config.json",
    port: 4318,
  });
  assert.deepEqual(parseReviewArguments([]), {});
  for (const args of [["--port", "0"], ["--port", "65536"], ["--port", "abc"], ["--port", "4317", "--port", "4318"], ["--config"], ["--unknown"]]) {
    assert.throws(() => parseReviewArguments(args));
  }
});

test("review API reads local transaction state and sends same-origin actions", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ReviewApiClient(4319, async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const payload = url.endsWith("/api/state") ? { transactions: [] }
      : url.endsWith("/snapshot") ? { before: { count: 2 }, previewAfter: { count: 1 } }
        : { status: "COMMITTED" };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await client.getState(), { transactions: [] });
  assert.deepEqual(await client.getSnapshot("tx_123"), { before: { count: 2 }, previewAfter: { count: 1 } });
  assert.deepEqual(await client.act("tx_123", "approve"), { status: "COMMITTED" });
  assert.deepEqual(requests.map(({ url, init }) => [url, init?.method ?? "GET"]), [
    ["http://127.0.0.1:4319/api/state", "GET"],
    ["http://127.0.0.1:4319/api/tx/tx_123/snapshot", "GET"],
    ["http://127.0.0.1:4319/api/tx/tx_123/approve", "POST"],
  ]);
  assert.equal(new Headers(requests[2].init?.headers).get("origin"), "http://127.0.0.1:4319");
  assert.equal(requests[2].init?.body, "");

  const rejected = new ReviewApiClient(4319, async () => new Response(JSON.stringify({ error: "Conflict\u001b[31m\nretry" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(rejected.act("tx_123", "approve"), (error: unknown) => error instanceof Error && error.message === "Conflict retry");
  assert.throws(() => new ReviewApiClient(0), /port must be an integer/);
});

test("client config paths resolve to documented global and Cursor project locations", () => {
  const windowsHome = "C:\\Users\\Ada";
  assert.equal(
    resolveClientConfigPath("claude", { platform: "win32", home: windowsHome, env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" } }),
    "C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  assert.equal(
    resolveClientConfigPath("cursor", { platform: "win32", home: windowsHome }),
    "C:\\Users\\Ada\\.cursor\\mcp.json",
  );
  assert.equal(
    resolveClientConfigPath("windsurf", { platform: "win32", home: windowsHome }),
    "C:\\Users\\Ada\\.codeium\\windsurf\\mcp_config.json",
  );
  assert.equal(
    resolveClientConfigPath("cursor", { platform: "win32", home: windowsHome, project: true, cwd: "D:\\work\\app" }),
    "D:\\work\\app\\.cursor\\mcp.json",
  );
  assert.equal(
    resolveClientConfigPath("claude", { platform: "darwin", home: "/Users/ada" }),
    "/Users/ada/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.throws(() => resolveClientConfigPath("claude", { platform: "linux", home: "/home/ada" }), /supported on Windows and macOS/);
});

test("Claude installer detects Windows MSIX config locations and refuses ambiguity", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".hypermcp-cli-"));
  try {
    const localAppData = path.join(directory, "AppData", "Local");
    const packageRoot = path.join(localAppData, "Packages", "Claude_test");
    const packagedConfig = path.join(packageRoot, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
    await mkdir(path.dirname(packagedConfig), { recursive: true });
    await writeFile(packagedConfig, "{}", "utf8");
    const options = {
      platform: "win32" as NodeJS.Platform,
      home: directory,
      env: { USERPROFILE: directory, APPDATA: path.join(directory, "AppData", "Roaming"), LOCALAPPDATA: localAppData },
    };
    assert.equal(await resolveClientConfigTarget("claude", options), packagedConfig);

    await mkdir(path.join(localAppData, "Packages", "Anthropic.ClaudeDesktop_other"), { recursive: true });
    assert.equal(await resolveClientConfigTarget("claude", options), packagedConfig, "an existing unique config should identify the installed app");

    await rm(packagedConfig);
    await assert.rejects(resolveClientConfigTarget("claude", options), /Multiple packaged Claude Desktop installs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("client config install preserves other entries, backs up changes, and is idempotent", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".hypermcp-cli-"));
  try {
    const configPath = path.join(directory, "cursor", "mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = [
      "{",
      "\t\"theme\": \"dark\",",
      "\t\"mcpServers\": {",
      "\t\t\"existing\": {",
      "\t\t\t\"command\": \"npx\",",
      "\t\t\t\"args\": []",
      "\t\t}",
      "\t}",
      "}",
      "",
    ].join("\r\n");
    await writeFile(configPath, original, "utf8");
    const server = { command: "node", args: ["/opt/hypermcp/dist/index.js", "start"] };
    const first = await installClientConfig({ configPath, serverName: "hypermcp", server, now: new Date("2026-01-02T03:04:05.006Z") });
    assert.equal(first.changed, true);
    assert.ok(first.backupPath);
    assert.equal(await readFile(first.backupPath!, "utf8"), original);

    const installedText = await readFile(configPath, "utf8");
    const installed = JSON.parse(installedText);
    assert.equal(installed.theme, "dark");
    assert.equal(installed.mcpServers.existing.command, "npx");
    assert.deepEqual(installed.mcpServers.hypermcp, server);
    assert.ok(installedText.includes("\r\n"), "Windows line endings should be preserved.");
    assert.ok(installedText.includes("\t\"hypermcp\""), "Detected indentation should be preserved.");

    const second = await installClientConfig({ configPath, serverName: "hypermcp", server });
    assert.equal(second.changed, false);
    assert.equal(second.backupPath, undefined);

    const beforeConflict = await readFile(configPath);
    await assert.rejects(
      installClientConfig({ configPath, serverName: "hypermcp", server: { command: "other" } }),
      /--replace/,
    );
    assert.deepEqual(await readFile(configPath), beforeConflict, "A conflicting entry must remain untouched without --replace.");

    const replacement = { command: "node", args: ["/opt/hypermcp/new.js", "start"] };
    const replaced = await installClientConfig({
      configPath,
      serverName: "hypermcp",
      server: replacement,
      replace: true,
      now: new Date("2026-01-02T03:04:06.007Z"),
    });
    assert.equal(replaced.changed, true);
    assert.ok(replaced.backupPath);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).mcpServers.hypermcp, replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new client config is created exclusively and invalid JSON is left untouched", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".hypermcp-cli-"));
  try {
    const freshPath = path.join(directory, "new", "mcp.json");
    const created = await installClientConfig({ configPath: freshPath, serverName: "hypermcp", server: { command: "node", args: [] } });
    assert.equal(created.changed, true);
    assert.equal(created.backupPath, undefined);
    assert.equal(JSON.parse(await readFile(freshPath, "utf8")).mcpServers.hypermcp.command, "node");

    const invalidPath = path.join(directory, "invalid.json");
    await writeFile(invalidPath, "{ this is not JSON", "utf8");
    await assert.rejects(
      installClientConfig({ configPath: invalidPath, serverName: "hypermcp", server: { command: "node", args: [] } }),
      /Cannot safely edit client config/,
    );
    assert.equal(await readFile(invalidPath, "utf8"), "{ this is not JSON");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built HyperMCP CLI installs idempotently without relying on the caller's PATH", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".hypermcp-cli-"));
  try {
    const target = path.join(directory, "custom-client", "mcp.json");
    const args = [
      path.resolve("bin/hypermcp.js"),
      "install", "cursor",
      "--config", path.resolve("hypermcp.config.example.json"),
      "--client-config", target,
    ];
    const first = await execFileAsync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
    assert.match(first.stdout, /Installed HyperMCP/);
    const entry = JSON.parse(await readFile(target, "utf8")).mcpServers.hypermcp;
    assert.equal(entry.command, process.execPath);
    assert.ok(entry.args.includes(path.resolve("dist/index.js")));

    const second = await execFileAsync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
    assert.match(second.stdout, /already configured/);
    const files = await readdir(path.dirname(target));
    assert.equal(files.filter((name) => name.endsWith(".bak")).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
