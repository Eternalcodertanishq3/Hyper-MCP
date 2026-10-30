import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, lstat, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type McpClient = "claude" | "cursor" | "windsurf";

export interface ClientConfigPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  project?: boolean;
}

function pathFor(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function resolveClientConfigPath(client: McpClient, options: ClientConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = pathFor(platform);
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? process.cwd();

  if (options.project) {
    if (client !== "cursor") throw new Error("Project-scoped installation is currently supported only for Cursor.");
    return pathApi.resolve(options.cwd ?? process.cwd(), ".cursor", "mcp.json");
  }

  if (client === "claude") {
    if (platform === "win32") {
      const roaming = env.APPDATA || pathApi.join(home, "AppData", "Roaming");
      return pathApi.join(roaming, "Claude", "claude_desktop_config.json");
    }
    if (platform === "darwin") return pathApi.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    throw new Error("Claude Desktop configuration install is supported on Windows and macOS. On other systems, use `hypermcp wrap` and configure the MCP client manually.");
  }

  if (client === "cursor") return pathApi.join(home, ".cursor", "mcp.json");
  if (client === "windsurf") return pathApi.join(home, ".codeium", "windsurf", "mcp_config.json");
  throw new Error("Unsupported MCP client: " + String(client));
}

export async function resolveClientConfigTarget(client: McpClient, options: ClientConfigPathOptions = {}): Promise<string> {
  const standardPath = resolveClientConfigPath(client, options);
  const platform = options.platform ?? process.platform;
  if (client !== "claude" || platform !== "win32" || options.project) return standardPath;

  const env = options.env ?? process.env;
  const pathApi = pathFor(platform);
  const home = options.home ?? env.USERPROFILE ?? process.cwd();
  const localAppData = env.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local");
  const packagesPath = pathApi.join(localAppData, "Packages");
  let entries: string[];
  try {
    entries = await readdir(packagesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return standardPath;
    throw new Error("Could not inspect packaged Claude Desktop config locations. Use --client-config to choose the file explicitly.");
  }

  const packageRoots: string[] = [];
  for (const name of entries.filter((entry) => /claude/i.test(entry))) {
    const packageRoot = pathApi.join(packagesPath, name);
    if (await stat(packageRoot).then((info) => info.isDirectory()).catch(() => false)) packageRoots.push(packageRoot);
  }
  if (packageRoots.length === 0) return standardPath;

  const candidates = packageRoots.map((root) => pathApi.join(root, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
  const existing = [] as string[];
  for (const candidate of candidates) {
    if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) existing.push(candidate);
  }
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) throw new Error("Multiple packaged Claude Desktop configs exist. Use --client-config to select the intended one.");
  if (candidates.length === 1) return candidates[0];
  throw new Error("Multiple packaged Claude Desktop installs were found. Use --client-config to select the intended config path.");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "undefined";
}

function detectFormatting(original: string): { indent: string | number; eol: string; trailingNewline: boolean } {
  const indentMatch = original.match(/(?:^|\r?\n)([ \t]+)"/);
  return {
    indent: indentMatch?.[1] ?? 2,
    eol: original.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: original.endsWith("\n"),
  };
}

export interface InstallClientConfigOptions {
  configPath: string;
  serverName: string;
  server: Record<string, unknown>;
  replace?: boolean;
  now?: Date;
}

export interface InstallClientConfigResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
}

const MAX_CLIENT_CONFIG_BYTES = 1024 * 1024;

export async function installClientConfig(options: InstallClientConfigOptions): Promise<InstallClientConfigResult> {
  const configPath = path.resolve(options.configPath);
  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true });

  let original: Buffer | undefined;
  let mode = 0o600;
  try {
    const info = await lstat(configPath);
    if (info.isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link client config: " + configPath);
    if (!info.isFile()) throw new Error("Client config path is not a regular file: " + configPath);
    if (info.size > MAX_CLIENT_CONFIG_BYTES) throw new Error("Client config is larger than the 1 MiB safety limit: " + configPath);
    original = await readFile(configPath);
    mode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let root: Record<string, unknown> = {};
  let existingServers: Record<string, unknown> = {};
  if (original) {
    try {
      const parsed: unknown = JSON.parse(original.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top-level value must be an object");
      root = parsed as Record<string, unknown>;
      if (root.mcpServers !== undefined) {
        if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) throw new Error("mcpServers must be an object");
        existingServers = root.mcpServers as Record<string, unknown>;
      }
    } catch (error) {
      throw new Error("Cannot safely edit client config " + configPath + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }

  const previous = existingServers[options.serverName];
  if (previous !== undefined && canonical(previous) === canonical(options.server)) {
    return { configPath, changed: false };
  }
  if (previous !== undefined && !options.replace) {
    throw new Error("A different MCP server named '" + options.serverName + "' is already configured in " + configPath + ". Review it, or rerun with --replace to back it up and replace it.");
  }

  root.mcpServers = { ...existingServers, [options.serverName]: options.server };
  const formatting = detectFormatting(original?.toString("utf8") ?? "");
  const serialized = JSON.stringify(root, null, formatting.indent).replace(/\n/g, formatting.eol) + (formatting.trailingNewline || !original ? formatting.eol : "");

  let backupPath: string | undefined;
  if (original) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backupPath = configPath + "." + stamp + ".bak";
    const backup = await open(backupPath, "wx", mode);
    let backupComplete = false;
    try {
      await backup.writeFile(original);
      await backup.sync();
      backupComplete = true;
    } finally {
      await backup.close();
      if (!backupComplete) await unlink(backupPath).catch(() => undefined);
    }

    const currentInfo = await lstat(configPath);
    if (currentInfo.isSymbolicLink()) throw new Error("Client config changed to a symbolic link during install; no config was changed.");
    const current = await readFile(configPath);
    if (!current.equals(original)) throw new Error("Client config changed during install; no config was changed. Backup saved at " + backupPath);

    const temporaryPath = path.join(directory, "." + path.basename(configPath) + "." + randomUUID() + ".tmp");
    try {
      const file = await open(temporaryPath, "wx", mode);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, configPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  } else {
    const file = await open(configPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }

  return { configPath, changed: true, ...(backupPath ? { backupPath } : {}) };
}
