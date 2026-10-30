import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecurityEvent } from "../config/types.ts";

export interface ToolFingerprintInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolLockRecord {
  hash: string;
  blocked: boolean;
  reason?: string;
}

export interface ServerLockRecord {
  [toolName: string]: ToolLockRecord;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function fingerprintTool(tool: ToolFingerprintInput): string {
  const normalized = { name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} };
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

const injectionPatterns = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /<\/?system\b/i,
  /\bexfiltrate\b/i,
  /(?:~\/\.ssh|\.env(?:\b|\/))/i,
  /\bcurl\s+https?:\/\//i,
  /send\s+(?:the\s+)?(?:secret|credential|key|token)\s+to/i,
];

export function promptInjectionReason(description: string): string | undefined {
  const match = injectionPatterns.find((pattern) => pattern.test(description));
  return match ? "suspicious tool description matched " + match.source : undefined;
}

export class SchemaLock {
  private records: Record<string, ServerLockRecord> = {};
  readonly events: SecurityEvent[] = [];
  private firstBoot = false;

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    try {
      this.records = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, ServerLockRecord>;
      if (!this.records || typeof this.records !== "object" || Array.isArray(this.records)) throw new Error("MCP-Lock file must contain a JSON object.");
      this.firstBoot = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records = {};
      this.firstBoot = true;
    }
  }

  async inspect(server: string, tools: ToolFingerprintInput[]): Promise<Map<string, ToolLockRecord>> {
    const prior = this.records[server] ?? {};
    this.records[server] = { ...prior };
    for (const tool of tools) {
      const hash = fingerprintTool(tool);
      const priorTool = prior[tool.name];
      const injectionReason = promptInjectionReason(tool.description ?? "");
      const changed = Boolean(priorTool && priorTool.hash !== hash);
      const reason = injectionReason ?? (this.firstBoot ? undefined : !priorTool ? "tool was not present in the pinned schema lock" : changed ? "tool schema or description changed since it was pinned" : priorTool.reason);
      this.records[server][tool.name] = {
        hash: priorTool?.hash ?? hash,
        blocked: Boolean(reason || priorTool?.blocked),
        ...(reason ? { reason } : priorTool?.reason ? { reason: priorTool.reason } : {}),
      };
      if (reason && (!priorTool?.blocked || priorTool.reason !== reason)) this.recordBlocked(server, tool.name, reason);
    }
    return new Map(Object.entries(this.records[server] ?? {}));
  }

  async finishFirstBoot(): Promise<void> {
    if (!this.firstBoot) return;
    await this.persist();
    for (const [server, tools] of Object.entries(this.records)) {
      this.events.push({ id: randomUUID(), type: "SCHEMA_LOCK_INITIALIZED", server, tool: "*", message: "Pinned " + Object.keys(tools).length + " tool schemas.", createdAt: new Date().toISOString() });
    }
    this.firstBoot = false;
  }

  private recordBlocked(server: string, tool: string, reason: string): void {
    this.events.push({ id: randomUUID(), type: "RUG_PULL_BLOCKED", server, tool, message: reason, createdAt: new Date().toISOString() });
  }

  private async persist(): Promise<void> {
    const absolutePath = path.resolve(this.filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = absolutePath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporaryPath, JSON.stringify(this.records, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await import("node:fs/promises").then(({ rm }) => rm(temporaryPath, { force: true })).catch(() => undefined);
      throw error;
    }
  }

  getRecord(server: string, tool: string): ToolLockRecord | undefined {
    return this.records[server]?.[tool];
  }

  getStatus(): { path: string; pinnedTools: number; blockedTools: number; events: SecurityEvent[] } {
    const all = Object.values(this.records).flatMap((server) => Object.values(server));
    return { path: this.filePath, pinnedTools: all.length, blockedTools: all.filter((record) => record.blocked).length, events: [...this.events] };
  }
}
