import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditErrorCategory, HyperMCPConfig, IndexedTool, JsonObject, SnapshotPlan, StagedTransaction, UpstreamServerConfig, SQLiteOccConfig, SQLiteOccMutation, SQLiteOccSchema, SQLiteOccSnapshot, SQLiteOccValue } from "../config/types.ts";
import { buildUpstreamEnvironment } from "../config/environment.ts";
import { estimateTokens } from "./tokenizer.ts";
import { ToolRouter } from "./router.ts";
import { SqlEngine } from "../pipe/sqlEngine.ts";
import { virtualizeOutput } from "../pipe/virtualizer.ts";
import { SecretVault } from "../lock/secretVault.ts";
import { SchemaLock } from "../lock/schemaLock.ts";
import { StagingManager } from "../stage/stagingManager.ts";
import { TransactionJournal } from "../stage/journal.ts";
import { SnapshotStore } from "../stage/snapshotStore.ts";
import { RollbackEngine } from "../stage/rollbackEngine.ts";
import { buildSQLiteOccReadQuery, buildSQLiteOccRestoreQuery, buildSQLiteOccWriteQuery, parseSQLiteOccMutation, quoteSQLiteText, sameSQLiteOccRow, validateSQLiteOccRow, validateSQLiteOccSchema } from "../stage/sqliteOcc.ts";
import { DashboardServer } from "../dashboard/server.ts";

interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: Transport;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function unpackResult(result: { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): unknown {
  if (result.isError) {
    const message = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") || "Upstream MCP tool failed.";
    throw new Error(message);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "") ?? [];
  if (texts.length === 1) {
    try { return JSON.parse(texts[0]); } catch { return texts[0]; }
  }
  if (texts.length > 1) return texts.map((text) => { try { return JSON.parse(text); } catch { return text; } });
  return result.content ?? [];
}

function findRows(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) return value as Record<string, unknown>[];
  if (!value || typeof value !== "object") return undefined;
  return Object.values(value as Record<string, unknown>).map(findRows).filter((rows): rows is Record<string, unknown>[] => Boolean(rows)).sort((a, b) => b.length - a.length)[0];
}

function filterInactive(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((row) => !(row && typeof row === "object" && Number((row as Record<string, unknown>).inactive_days) > 90));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, filterInactive(child)]));
}

function dashboardSnapshot(value: unknown): unknown {
  const rows = findRows(value);
  if (rows) {
    return {
      ...(value && typeof value === "object" && !Array.isArray(value) && "table" in value ? { table: (value as Record<string, unknown>).table } : {}),
      rows: rows.slice(0, 4),
      total_rows: rows.length,
      truncated: rows.length > 4,
    };
  }
  const encoded = JSON.stringify(value);
  return encoded && encoded.length > 2048 ? { preview: encoded.slice(0, 2048), truncated: true } : value;
}

function dashboardTransaction(transaction: StagedTransaction, scrub: (value: unknown) => unknown): Record<string, unknown> {
  return {
    id: transaction.id,
    server: transaction.server,
    tool: transaction.tool,
    status: transaction.status,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    diffSummary: transaction.diffSummary,
    affectedRows: transaction.affectedRows,
    ...(transaction.error ? { error: transaction.error } : {}),
    before: dashboardSnapshot(scrub(transaction.before)),
    ...(transaction.previewAfter !== undefined ? { previewAfter: dashboardSnapshot(scrub(transaction.previewAfter)) } : {}),
    ...(transaction.after !== undefined ? { after: dashboardSnapshot(scrub(transaction.after)) } : {}),
  };
}

function toolTransactionSummary(transaction: StagedTransaction): Record<string, unknown> {
  return {
    id: transaction.id,
    server: transaction.server,
    tool: transaction.tool,
    status: transaction.status,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    diffSummary: transaction.diffSummary,
    affectedRows: transaction.affectedRows,
    ...(transaction.errorCategory ? { errorCategory: transaction.errorCategory } : {}),
  };
}

function categorizeUpstreamError(error: unknown): AuditErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:ETIMEDOUT|ECONNRESET|timed?\s*out|timeout)/i.test(message)
    ? "NETWORK_TIMEOUT"
    : "UPSTREAM_EXECUTION_ERROR";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => JSON.stringify(key) + ":" + stableJson(child)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function snapshotPlanHash(plan: SnapshotPlan): string {
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

function sqliteOccPlanHash(plan: SQLiteOccConfig): string {
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

function sameIdentifierForRuntime(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function sqliteOccSnapshot(table: string, primaryKey: string, rows: Record<string, SQLiteOccValue>[]): SQLiteOccSnapshot {
  return { table, primaryKey, rows };
}

function isSQLiteOccSnapshot(value: unknown): value is SQLiteOccSnapshot {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as SQLiteOccSnapshot).table && (value as SQLiteOccSnapshot).primaryKey && Array.isArray((value as SQLiteOccSnapshot).rows));
}

function containsSecretToken(value: unknown): boolean {
  if (typeof value === "string") return /\$secret:v_\d{3,}/.test(value);
  if (Array.isArray(value)) return value.some(containsSecretToken);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => /\$secret:v_\d{3,}/.test(key) || containsSecretToken(child));
  return false;
}

export class HyperMCPRuntime extends EventEmitter {
  readonly sql = new SqlEngine();
  readonly vault: SecretVault;
  readonly schemaLock: SchemaLock;
  readonly router = new ToolRouter();
  readonly staging: StagingManager;
  readonly snapshots: SnapshotStore | undefined;
  readonly snapshotRetentionEnabled: boolean;
  readonly rollback: RollbackEngine;
  private readonly connections = new Map<string, UpstreamConnection>();
  private readonly tools = new Map<string, IndexedTool>();
  private readonly sqliteOccSchemas = new Map<string, SQLiteOccSchema>();
  private readonly activeTransactions = new Set<string>();
  private readonly activeServers = new Set<string>();
  private readonly transactionIdleWaiters = new Set<() => void>();
  private dashboard?: DashboardServer;
  private started = false;

  constructor(readonly config: HyperMCPConfig, options: { journalPath?: string; snapshotPath?: string } = {}) {
    super();
    const journal = new TransactionJournal({ path: options.journalPath });
    this.staging = new StagingManager(journal);
    const retentionHours = config.policies.snapshotRetentionHours ?? 0;
    this.snapshotRetentionEnabled = retentionHours > 0;
    const snapshotPath = options.snapshotPath ?? path.join(path.dirname(journal.databasePath), "snapshots", "snapshots.sqlite");
    if (this.snapshotRetentionEnabled || existsSync(snapshotPath)) {
      try {
        this.snapshots = new SnapshotStore({
          databasePath: snapshotPath,
          sessionId: journal.sessionId,
          pid: process.pid,
          enabled: this.snapshotRetentionEnabled,
          retentionHours,
          quotaBytes: (config.policies.maxSnapshotStorageMb ?? 50) * 1024 * 1024,
          isSessionActive: (sessionId) => journal.isSessionActive(sessionId),
          onInterruptedRestore: (id) => {
            if (journal.find(id)) journal.updateExisting(id, "OUTCOME_UNKNOWN", "DISPATCH_INTERRUPTED");
          },
        });
      } catch (error) {
        journal.close();
        throw error;
      }
    } else this.snapshots = undefined;
    this.vault = new SecretVault(config.policies.maskEmails);
    this.schemaLock = new SchemaLock(config.lockFile);
    this.rollback = new RollbackEngine({
      call: (server, tool, args) => this.callUpstreamRaw(server, tool, this.hydrateOutbound(args, true)),
    });
  }

  async start(options: { dashboard?: boolean } = {}): Promise<void> {
    if (this.started) return;
    try {
      await this.schemaLock.initialize();
      for (const serverConfig of this.config.servers) await this.connectUpstream(serverConfig);
      await this.schemaLock.finishFirstBoot();
      const serverPolicies = new Map(this.config.servers.map((server) => [server.name, server]));
      this.router.replaceTools([...this.tools.values()].filter((tool) => {
        const policy = serverPolicies.get(tool.server);
        return !policy?.internalTools?.includes(tool.name) && (policy?.readOnlyTools?.includes(tool.name) || policy?.stagedTools?.[tool.name] || policy?.sqliteOcc?.writeTool === tool.name);
      }));
      if (options.dashboard !== false) {
        this.dashboard = new DashboardServer(this.config.dashboardPort, this);
        await this.dashboard.start();
      }
      this.started = true;
      this.changed();
    } catch (error) {
      await this.dashboard?.close().catch(() => undefined);
      this.dashboard = undefined;
      await this.closeUpstreams();
      this.snapshots?.close();
      this.staging.close();
      throw error;
    }
  }

  private async connectUpstream(config: UpstreamServerConfig): Promise<void> {
    if (this.connections.has(config.name)) throw new Error("Duplicate upstream name: " + config.name);
    let transport: Transport;
    if (config.transport === "streamable-http") {
      if (!config.url) throw new Error("Upstream " + config.name + " needs a URL for Streamable HTTP.");
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    } else if (config.transport === "sse") {
      if (!config.url) throw new Error("Upstream " + config.name + " needs a URL for SSE.");
      transport = new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    } else {
      if (!config.command) throw new Error("Upstream " + config.name + " needs a command for stdio.");
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: buildUpstreamEnvironment(config.env),
        stderr: "inherit",
      });
    }
    const client = new Client({ name: "hypermcp-runtime", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.connections.set(config.name, { config, client, transport });
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const stagedNames = Object.keys(config.stagedTools ?? {});
    const declaredNames = [...(config.readOnlyTools ?? []), ...stagedNames, ...(config.internalTools ?? []), ...(config.sqliteOcc ? [config.sqliteOcc.writeTool] : [])];
    if (new Set(declaredNames).size !== declaredNames.length) throw new Error("Upstream " + config.name + " has overlapping tool policy entries.");
    for (const toolName of declaredNames) if (!names.has(toolName)) throw new Error("Upstream " + config.name + " policy references missing tool " + toolName + ".");
    for (const [toolName, plan] of Object.entries(config.stagedTools ?? {})) {
      if (!names.has(plan.tool) || !names.has(plan.restoreTool)) throw new Error("Staging plan for " + config.name + "." + toolName + " references a missing snapshot or restore tool.");
      if (!(config.readOnlyTools ?? []).includes(plan.tool)) throw new Error("Snapshot tool " + config.name + "." + plan.tool + " must be explicitly declared readOnlyTools.");
      if (!(config.internalTools ?? []).includes(plan.restoreTool)) throw new Error("Restore tool " + config.name + "." + plan.restoreTool + " must be declared internalTools.");
    }
    if (config.sqliteOcc) {
      if (!names.has(config.sqliteOcc.readTool) || !names.has(config.sqliteOcc.writeTool)) throw new Error("SQLite OCC policy for " + config.name + " references a missing read or write tool.");
      if (!(config.readOnlyTools ?? []).includes(config.sqliteOcc.readTool)) throw new Error("SQLite OCC read tool must be explicitly declared readOnlyTools.");
      const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const [toolName, argumentKey] of [[config.sqliteOcc.readTool, config.sqliteOcc.readArgumentKey], [config.sqliteOcc.writeTool, config.sqliteOcc.writeArgumentKey]] as const) {
        const schema = (toolByName.get(toolName)?.inputSchema as { properties?: Record<string, { type?: string }> } | undefined)?.properties;
        if (schema?.[argumentKey]?.type !== "string") throw new Error("SQLite OCC tool " + config.name + "." + toolName + " must accept a string argument named " + argumentKey + ".");
      }
      const readOutput = (toolByName.get(config.sqliteOcc.readTool) as { outputSchema?: { properties?: Record<string, { type?: string }> } } | undefined)?.outputSchema?.properties;
      const writeOutput = (toolByName.get(config.sqliteOcc.writeTool) as { outputSchema?: { properties?: Record<string, { type?: string }> } } | undefined)?.outputSchema?.properties;
      if (readOutput?.rows?.type !== "array") throw new Error("SQLite OCC readTool must declare an outputSchema with a rows array.");
      if (writeOutput?.affected_rows?.type !== "integer") {
        throw new Error("SQLite OCC writeTool must declare an outputSchema with an integer affected_rows field.");
      }
    }
    for (const toolName of config.secretHydrationTools ?? []) {
      if (!stagedNames.includes(toolName)) throw new Error("Secret hydration target " + config.name + "." + toolName + " must use staged approval.");
    }
    const lockRecords = await this.schemaLock.inspect(config.name, tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
    })));
    for (const tool of tools) {
      const record = lockRecords.get(tool.name);
      const blocked = Boolean(record?.blocked);
      const description = blocked
        ? "[Blocked by MCP-Lock: " + (record?.reason ?? "schema mismatch") + "]"
        : config.sqliteOcc?.writeTool === tool.name
          ? "[HyperMCP SQLite OCC staged write: only allowlisted single-row literal UPDATE/DELETE statements are accepted; expressions and bulk predicates are refused.] " + (tool.description ?? "")
          : (tool.description ?? "");
      const indexed: IndexedTool = {
        server: config.name,
        name: tool.name,
        description: this.vault.scrubString(description),
        inputSchema: this.vault.scrub(tool.inputSchema) as Record<string, unknown>,
        lockStatus: blocked ? "BLOCKED_RUG_PULL" : "VERIFIED",
        ...(record?.reason ? { lockReason: record.reason } : {}),
      };
      this.tools.set(this.key(config.name, tool.name), indexed);
    }
    if (config.sqliteOcc) await this.initializeSQLiteOccSchemas(config.name, config.sqliteOcc);
    this.changed();
  }

  private key(server: string, tool: string): string {
    return server + "\u0000" + tool;
  }

  private async callSQLiteOccTool(server: string, tool: string, argumentKey: string, query: string): Promise<Record<string, unknown>> {
    const connection = this.connections.get(server);
    if (!connection) throw new Error("SQLITE_OCC_PROTOCOL_ERROR: upstream connection is unavailable.");
    const indexed = this.tools.get(this.key(server, tool));
    if (!indexed || indexed.lockStatus === "BLOCKED_RUG_PULL") throw new Error("RUG_PULL_DETECTED: the configured SQLite OCC tool is blocked by MCP-Lock.");
    try {
      const result = await connection.client.callTool({ name: tool, arguments: { [argumentKey]: query } });
      if (result.isError) throw new Error("upstream returned an MCP tool error");
      if (!result.structuredContent || typeof result.structuredContent !== "object" || Array.isArray(result.structuredContent)) {
        throw new Error("missing structuredContent object");
      }
      return result.structuredContent as Record<string, unknown>;
    } catch {
      throw new Error("SQLITE_OCC_UPSTREAM_ERROR: expected a successful tool result with structuredContent.");
    }
  }

  private async readSQLiteOccRows(server: string, query: string): Promise<Record<string, unknown>[]> {
    const policy = this.connections.get(server)?.config.sqliteOcc;
    if (!policy) throw new Error("SQLITE_OCC_CONFIG_ERROR: adapter policy is unavailable.");
    const result = await this.callSQLiteOccTool(server, policy.readTool, policy.readArgumentKey, query);
    if (!Array.isArray(result.rows) || result.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("SQLITE_OCC_PROTOCOL_ERROR: readTool structuredContent must contain a rows array of objects.");
    }
    if (result.rows.length > 10_000) throw new Error("SQLITE_OCC_PROTOCOL_ERROR: readTool returned more rows than the adapter permits.");
    return result.rows as Record<string, unknown>[];
  }

  private async writeSQLiteOcc(server: string, query: string): Promise<number> {
    const policy = this.connections.get(server)?.config.sqliteOcc;
    if (!policy) throw new Error("SQLITE_OCC_CONFIG_ERROR: adapter policy is unavailable.");
    const result = await this.callSQLiteOccTool(server, policy.writeTool, policy.writeArgumentKey, query);
    if (!Number.isSafeInteger(result.affected_rows) || (result.affected_rows as number) < 0) {
      throw new Error("SQLITE_OCC_PROTOCOL_ERROR: writeTool structuredContent must contain a non-negative integer affected_rows.");
    }
    return result.affected_rows as number;
  }

  private async inspectSQLiteOccSchema(server: string, target: SQLiteOccConfig["tables"][number]): Promise<SQLiteOccSchema> {
    const tableName = quoteSQLiteText(target.name);
    const tableRows = await this.readSQLiteOccRows(server,
      "SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND name = " + tableName);
    const columnRows = await this.readSQLiteOccRows(server,
      "SELECT name, type, \"notnull\" AS notnull_value, pk, hidden FROM pragma_table_xinfo(" + tableName + ") ORDER BY cid");
    const indexList = await this.readSQLiteOccRows(server,
      "SELECT name, \"unique\" AS is_unique, partial FROM pragma_index_list(" + tableName + ") ORDER BY seq");
    if (indexList.length > 128) throw new Error("SQLITE_OCC_SCHEMA_ERROR: too many indexes to safely inspect for " + target.name + ".");
    const indexRows: Record<string, unknown>[] = [];
    for (const index of indexList) {
      if (Number(index.is_unique) !== 1) continue;
      const indexName = String(index.name ?? "");
      const details = await this.readSQLiteOccRows(server,
        "SELECT seqno, cid, name AS column_name, \"key\" AS is_key FROM pragma_index_xinfo(" + quoteSQLiteText(indexName) + ") ORDER BY seqno");
      for (const detail of details) indexRows.push({ ...detail, index_name: indexName, is_unique: index.is_unique, partial: index.partial });
    }
    return validateSQLiteOccSchema({
      table: target.name,
      primaryKey: target.primaryKey,
      allowedColumns: target.allowedColumns,
      tableRows,
      columnRows,
      indexRows,
    });
  }

  private async initializeSQLiteOccSchemas(server: string, policy: SQLiteOccConfig): Promise<void> {
    for (const target of policy.tables) {
      const schema = await this.inspectSQLiteOccSchema(server, target);
      this.sqliteOccSchemas.set(this.key(server, schema.table.toLocaleLowerCase("en-US")), schema);
    }
  }

  private async verifySQLiteOccSchema(server: string, table: string): Promise<SQLiteOccSchema> {
    const policy = this.connections.get(server)?.config.sqliteOcc;
    const target = policy?.tables.find((candidate) => sameIdentifierForRuntime(candidate.name, table));
    const cached = this.sqliteOccSchema(server, table);
    if (!target) throw new Error("SQLITE_OCC_SCHEMA_ERROR: table is not configured for SQLite OCC.");
    const current = await this.inspectSQLiteOccSchema(server, target);
    if (stableJson(current) !== stableJson(cached)) throw new Error("SQLITE_OCC_SCHEMA_ERROR: SQLite table schema changed since startup; no write was dispatched.");
    return current;
  }

  private sqliteOccSchema(server: string, table: string): SQLiteOccSchema {
    const schema = this.sqliteOccSchemas.get(this.key(server, table.toLocaleLowerCase("en-US")));
    if (!schema) throw new Error("SQLITE_OCC_SCHEMA_ERROR: table is not configured for SQLite OCC.");
    return schema;
  }

  private async readSQLiteOccRecord(server: string, schema: SQLiteOccSchema, key: string | number): Promise<Record<string, SQLiteOccValue>[]> {
    const rows = await this.readSQLiteOccRows(server, buildSQLiteOccReadQuery(schema, key));
    return rows.map((row) => validateSQLiteOccRow(row, schema));
  }

  private async stageSQLiteOcc(server: string, tool: string, args: JsonObject): Promise<unknown> {
    const policy = this.connections.get(server)?.config.sqliteOcc;
    if (!policy) throw new Error("SQLITE_OCC_CONFIG_ERROR: adapter policy is unavailable.");
    if (Object.keys(args).length !== 1 || typeof args[policy.writeArgumentKey] !== "string") {
      throw new Error("SQLITE_OCC_REJECTED: write tool must receive exactly one SQL string argument named " + policy.writeArgumentKey + ".");
    }
    const parsedMutation = parseSQLiteOccMutation(args[policy.writeArgumentKey] as string, policy.tables);
    const schema = this.sqliteOccSchema(server, parsedMutation.table);
    if (!sameIdentifierForRuntime(schema.primaryKey, parsedMutation.primaryKey)) throw new Error("SQLITE_OCC_SCHEMA_ERROR: configured key does not match the inspected schema.");
    const mutation: SQLiteOccMutation = parsedMutation.operation === "update"
      ? {
          ...parsedMutation,
          table: schema.table,
          primaryKey: schema.primaryKey,
          assignments: Object.fromEntries(Object.entries(parsedMutation.assignments).map(([column, value]) => {
            const canonical = schema.columns.find((item) => sameIdentifierForRuntime(item, column));
            if (!canonical) throw new Error("SQLITE_OCC_SCHEMA_ERROR: configured update column does not match the inspected schema.");
            return [canonical, value];
          })),
        }
      : { ...parsedMutation, table: schema.table, primaryKey: schema.primaryKey };
    if (this.activeServers.has(server)) throw new Error("UPSTREAM_BUSY: another transaction is changing " + server + ". Retry after it finishes.");
    this.activeServers.add(server);
    try {
      const rows = await this.readSQLiteOccRecord(server, schema, mutation.key);
      if (rows.length !== 1) throw new Error(rows.length === 0 ? "SQLITE_OCC_TARGET_NOT_FOUND: the key matched no row; no write was staged." : "SQLITE_OCC_SCHEMA_ERROR: the configured key matched multiple rows; no write was staged.");
      const before = sqliteOccSnapshot(schema.table, schema.primaryKey, rows);
      const previewRows = mutation.operation === "delete"
        ? []
        : [{ ...rows[0], ...mutation.assignments }];
      const transaction = this.staging.create({
        server,
        tool,
        arguments: { [policy.writeArgumentKey]: "[SQLite OCC parsed; raw SQL not retained in the journal]" },
        sqliteOccMutation: mutation,
        before,
        previewAfter: sqliteOccSnapshot(schema.table, schema.primaryKey, previewRows),
        affectedRows: 1,
      });
      this.changed();
      return {
        status: "STAGED_FOR_APPROVAL",
        tx_id: transaction.id,
        diff_summary: transaction.diffSummary,
        snapshot: "$snap:" + transaction.id,
        dashboard_url: this.dashboard?.url ?? "http://127.0.0.1:" + this.config.dashboardPort,
      };
    } finally {
      this.activeServers.delete(server);
    }
  }

  private async callUpstreamRaw(server: string, tool: string, args: JsonObject): Promise<unknown> {
    const connection = this.connections.get(server);
    if (!connection) throw new Error("Unknown upstream server: " + server);
    const indexed = this.tools.get(this.key(server, tool));
    if (!indexed) throw new Error("Unknown upstream tool " + server + "." + tool);
    if (indexed.lockStatus === "BLOCKED_RUG_PULL") throw new Error("RUG_PULL_DETECTED: " + server + "." + tool + " is blocked by MCP-Lock.");
    try {
      const result = await connection.client.callTool({ name: tool, arguments: args });
      return unpackResult(result);
    } catch (error) {
      throw new Error(this.vault.scrubString(error instanceof Error ? error.message : String(error)));
    }
  }

  private hydrateOutbound(value: unknown, allowSecrets = false): any {
    if (typeof value === "string") {
      const pointer = value.match(/^\$ref:([a-f0-9]{8})$/i);
      if (pointer) return this.sql.hydratePointer("$ref:" + pointer[1]);
      if (!allowSecrets && /\$secret:v_\d{3,}/.test(value)) throw new Error("SECRET_DESTINATION_BLOCKED: this tool is not allowed to receive vaulted secrets.");
      return this.vault.hydrateString(value);
    }
    if (Array.isArray(value)) return value.map((child) => this.hydrateOutbound(child, allowSecrets));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, this.hydrateOutbound(child, allowSecrets)]));
    return value;
  }

  private hydrateForTool(server: string, tool: string, value: unknown): any {
    const allowSecrets = (this.connections.get(server)?.config.secretHydrationTools ?? []).includes(tool);
    return this.hydrateOutbound(value, allowSecrets);
  }

  private async snapshot(server: string, plan: SnapshotPlan): Promise<unknown> {
    const value = await this.callUpstreamRaw(server, plan.tool, plan.arguments);
    const scrubbed = this.vault.scrub(value);
    if (Buffer.byteLength(JSON.stringify(scrubbed ?? null), "utf8") > 16 * 1024 * 1024) throw new Error("SNAPSHOT_TOO_LARGE: configured snapshots are limited to 16 MiB.");
    return scrubbed;
  }

  private transactionPlanHash(transaction: StagedTransaction): string {
    if (transaction.snapshotPlan) return snapshotPlanHash(transaction.snapshotPlan);
    const policy = this.connections.get(transaction.server)?.config.sqliteOcc;
    if (policy?.writeTool === transaction.tool) return sqliteOccPlanHash(policy);
    throw new Error("SNAPSHOT_PLAN_CHANGED: transaction has no supported snapshot plan.");
  }

  private sqliteOccMutationFor(transaction: StagedTransaction): SQLiteOccMutation {
    if (transaction.sqliteOccMutation) return transaction.sqliteOccMutation;
    if (!isSQLiteOccSnapshot(transaction.before) || !isSQLiteOccSnapshot(transaction.after) || transaction.before.rows.length !== 1) {
      throw new Error("SQLITE_OCC_RESTORE_UNSUPPORTED: the retained snapshots do not describe one SQLite row.");
    }
    const key = transaction.before.rows[0][transaction.before.primaryKey];
    if (key === null || (typeof key !== "string" && typeof key !== "number")) throw new Error("SQLITE_OCC_RESTORE_UNSUPPORTED: retained row has no supported key value.");
    return transaction.after.rows.length === 0
      ? { operation: "delete", table: transaction.before.table, primaryKey: transaction.before.primaryKey, key }
      : { operation: "update", table: transaction.before.table, primaryKey: transaction.before.primaryKey, key, assignments: {} };
  }

  private async currentSQLiteOccSnapshot(transaction: StagedTransaction, mutation = this.sqliteOccMutationFor(transaction)): Promise<SQLiteOccSnapshot> {
    const schema = this.sqliteOccSchema(transaction.server, mutation.table);
    const rows = await this.readSQLiteOccRecord(transaction.server, schema, mutation.key);
    if (rows.length > 1) throw new Error("SQLITE_OCC_SCHEMA_ERROR: configured unique key matched multiple rows.");
    return sqliteOccSnapshot(schema.table, schema.primaryKey, rows);
  }

  private sameSQLiteOccSnapshot(left: unknown, right: SQLiteOccSnapshot): boolean {
    return isSQLiteOccSnapshot(left) && left.table === right.table && left.primaryKey === right.primaryKey && left.rows.length === right.rows.length &&
      (left.rows.length === 0 || sameSQLiteOccRow(left.rows[0], right.rows[0]));
  }

  async searchTools(query: string, limit?: number): Promise<unknown> {
    const results = this.router.search(query, limit ?? this.config.policies.searchLimit);
    const servers = new Map(this.config.servers.map((server) => [server.name, server]));
    return results.map(({ server, name, description, inputSchema, lockStatus, lockReason, score }) => ({
      server, name, description, inputSchema, lock_status: lockStatus,
      access_mode: servers.get(server)?.internalTools?.includes(name) ? "internal" : servers.get(server)?.stagedTools?.[name] || servers.get(server)?.sqliteOcc?.writeTool === name ? "staged" : servers.get(server)?.readOnlyTools?.includes(name) ? "read_only" : "disabled",
      ...(lockReason ? { lock_reason: lockReason } : {}), score: Number(score.toFixed(3)),
    }));
  }

  async callTool(input: { server: string; tool: string; arguments: JsonObject }): Promise<unknown> {
    const indexed = this.tools.get(this.key(input.server, input.tool));
    if (!indexed) throw new Error("Unknown upstream tool " + input.server + "." + input.tool);
    if (indexed.lockStatus === "BLOCKED_RUG_PULL") throw new Error("RUG_PULL_DETECTED: " + input.server + "." + input.tool + " is blocked by MCP-Lock.");
    const config = this.connections.get(input.server)!.config;
    if (config.internalTools?.includes(input.tool)) throw new Error("INTERNAL_TOOL: " + input.server + "." + input.tool + " is reserved for HyperMCP snapshot and restore operations.");
    if (config.sqliteOcc?.writeTool === input.tool) return this.stageSQLiteOcc(input.server, input.tool, input.arguments);
    const snapshotPlan = config.stagedTools?.[input.tool];
    if (snapshotPlan) {
      if (this.activeServers.has(input.server)) throw new Error("UPSTREAM_BUSY: another transaction is changing " + input.server + ". Retry after it finishes.");
      this.activeServers.add(input.server);
      try {
        const before = await this.snapshot(input.server, snapshotPlan);
        const rows = findRows(before) ?? [];
        const affectedRows = /inactive/i.test(input.tool) ? rows.filter((row) => Number(row.inactive_days) > 90).length : Array.isArray(input.arguments.records) ? input.arguments.records.length : rows.length;
        const previewAfter = /(?:delete|remove).*inactive/i.test(input.tool)
          ? filterInactive(before)
          : Array.isArray(input.arguments.records) ? { rows: [...rows, ...input.arguments.records] } : before;
        const transaction = this.staging.create({
          server: input.server, tool: input.tool, arguments: this.vault.scrub(input.arguments) as JsonObject,
          snapshotPlan, before, previewAfter, affectedRows,
        });
        this.changed();
        return {
          status: "STAGED_FOR_APPROVAL",
          tx_id: transaction.id,
          diff_summary: transaction.diffSummary,
          snapshot: "$snap:" + transaction.id,
          dashboard_url: this.dashboard?.url ?? "http://127.0.0.1:" + this.config.dashboardPort,
        };
      } finally {
        this.activeServers.delete(input.server);
      }
    }
    if (!config.readOnlyTools?.includes(input.tool)) throw new Error("TOOL_POLICY_MISSING: " + input.server + "." + input.tool + " is not explicitly configured as read-only or staged.");
    const args = this.hydrateForTool(input.server, input.tool, input.arguments) as JsonObject;
    const raw = await this.callUpstreamRaw(input.server, input.tool, args);
    const scrubbed = this.vault.scrub(raw);
    const virtualized = virtualizeOutput(scrubbed, this.config.policies.virtualizeThresholdTokens, this.sql);
    this.changed();
    return virtualized.virtualized ? virtualized.receipt : virtualized.value;
  }

  async queryReference(sql: string): Promise<unknown> {
    const result = this.sql.query(sql);
    const virtualized = virtualizeOutput(result, this.config.policies.virtualizeThresholdTokens, this.sql);
    this.changed();
    return virtualized.virtualized ? virtualized.receipt : result;
  }

  async pipeData(input: {
    source_sql: string; target_server: string; target_tool: string; target_arg_key: string;
    batch_size?: number;
  }): Promise<unknown> {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.target_arg_key)) throw new Error("target_arg_key must be a simple JSON property name of at most 64 characters.");
    if (!this.connections.get(input.target_server)?.config.stagedTools?.[input.target_tool]) {
      throw new Error("PIPE_TARGET_NOT_STAGED: data pipes can only target explicitly configured write tools that require dashboard approval.");
    }
    const rows = this.sql.query(input.source_sql);
    const batchSize = Math.max(1, Math.min(500, input.batch_size ?? 100));
    const batches: unknown[] = [];
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const chunk = rows.slice(offset, offset + batchSize);
      const args = { [input.target_arg_key]: chunk } as JsonObject;
      batches.push(await this.callTool({
        server: input.target_server,
        tool: input.target_tool,
        arguments: args,
      }));
    }
    this.changed();
    return {
      rows_selected: rows.length,
      rows_transferred: 0,
      rows_staged: rows.length,
      batch_count: batches.length,
      batch_size: batchSize,
      staged_transactions: batches.filter((result: any) => result?.status === "STAGED_FOR_APPROVAL").map((result: any) => result.tx_id),
      tokens_transferred_to_model: 0,
      approximate_data_tokens_piped: estimateTokens(rows),
      results: batches,
    };
  }

  private async approveSQLiteOcc(transaction: StagedTransaction): Promise<StagedTransaction> {
    const mutation = this.sqliteOccMutationFor(transaction);
    let schema = this.sqliteOccSchema(transaction.server, mutation.table);
    let dispatched = false;
    let writeConfirmed = false;
    let reserved = false;
    let stateUpdated = false;
    let beforeSnapshot: SQLiteOccSnapshot | undefined;
    try {
      schema = await this.verifySQLiteOccSchema(transaction.server, mutation.table);
      beforeSnapshot = await this.currentSQLiteOccSnapshot(transaction, mutation);
      if (beforeSnapshot.rows.length !== 1) {
        this.staging.transition(transaction.id, "REJECTED", {
          error: "The reviewed row no longer exists or the configured key is no longer unique. Inspect the database and stage a new operation.",
          errorCategory: "STATE_CONFLICT",
        });
        stateUpdated = true;
        throw new Error("STATE_CONFLICT: the reviewed row is unavailable or no longer unique; no write was dispatched.");
      }
      if (!this.sameSQLiteOccSnapshot(transaction.before, beforeSnapshot)) {
        const previewRows = mutation.operation === "delete" ? [] : beforeSnapshot.rows.map((row) => ({ ...row, ...("assignments" in mutation ? mutation.assignments : {}) }));
        const diffSummary = beforeSnapshot.rows.length + " row" + (beforeSnapshot.rows.length === 1 ? "" : "s") + " affected by " + transaction.tool;
        this.staging.transition(transaction.id, "PENDING", {
          before: beforeSnapshot,
          previewAfter: sqliteOccSnapshot(schema.table, schema.primaryKey, previewRows),
          affectedRows: beforeSnapshot.rows.length,
          diffSummary,
          error: "Upstream row changed after staging. Review the updated diff and approve again.",
          errorCategory: "STATE_CONFLICT",
        });
        stateUpdated = true;
        throw new Error("STALE_SNAPSHOT: review the updated diff and approve again.");
      }

      if (this.snapshotRetentionEnabled && this.snapshots) {
        this.snapshots.reserve({
          id: transaction.id,
          server: transaction.server,
          tool: transaction.tool,
          planHash: this.transactionPlanHash(transaction),
          before: beforeSnapshot,
        });
        reserved = true;
      }
      this.staging.transition(transaction.id, "IN_FLIGHT", { error: undefined, errorCategory: undefined });
      this.changed();
      schema = await this.verifySQLiteOccSchema(transaction.server, mutation.table);
      const query = buildSQLiteOccWriteQuery(mutation, schema, beforeSnapshot.rows[0]);
      dispatched = true;
      const affectedRows = await this.writeSQLiteOcc(transaction.server, query);
      if (affectedRows === 0) {
        const latest = await this.currentSQLiteOccSnapshot(transaction, mutation).catch(() => beforeSnapshot!);
        if (this.snapshots && reserved) {
          try { this.snapshots.markUnavailable(transaction.id); } catch { /* The journal remains authoritative. */ }
          reserved = false;
        }
        if (latest.rows.length !== 1) {
          this.staging.transition(transaction.id, "REJECTED", {
            error: "The guarded write found that the row disappeared or the key was no longer unique. Inspect the database and stage a new operation.",
            errorCategory: "STATE_CONFLICT",
          });
          stateUpdated = true;
          this.changed();
          throw new Error("STATE_CONFLICT: the target row changed before the guarded write; no row was modified by HyperMCP.");
        }
        const previewRows = mutation.operation === "delete" ? [] : latest.rows.map((row) => ({ ...row, ...("assignments" in mutation ? mutation.assignments : {}) }));
        this.staging.transition(transaction.id, "PENDING", {
          before: latest,
          previewAfter: sqliteOccSnapshot(schema.table, schema.primaryKey, previewRows),
          affectedRows: latest.rows.length,
          error: "SQLite rejected the optimistic write because the row changed. Review the current row and approve again.",
          errorCategory: "STATE_CONFLICT",
        });
        stateUpdated = true;
        this.changed();
        throw new Error("STATE_CONFLICT: the row changed before the guarded write could apply.");
      }
      if (affectedRows !== 1) throw new Error("SQLITE_OCC_INVARIANT_ERROR: a schema-unique, single-row write reported an unexpected affected_rows count.");
      writeConfirmed = true;

      const afterRows = await this.readSQLiteOccRecord(transaction.server, schema, mutation.key);
      if ((mutation.operation === "delete" && afterRows.length !== 0) || (mutation.operation === "update" && afterRows.length !== 1)) {
        throw new Error("SQLITE_OCC_POST_WRITE_MISMATCH: the post-write row state did not match the reported write result.");
      }
      const afterSnapshot = sqliteOccSnapshot(schema.table, schema.primaryKey, afterRows);
      if (this.snapshots && reserved) {
        this.snapshots.complete(transaction.id, afterSnapshot, !containsSecretToken(beforeSnapshot) && !containsSecretToken(afterSnapshot));
        reserved = false;
      }
      const updated = this.staging.transition(transaction.id, "COMMITTED", { after: afterSnapshot, error: undefined, errorCategory: undefined });
      this.changed();
      return updated;
    } catch (error) {
      const message = this.vault.scrubString(error instanceof Error ? error.message : String(error));
      if (dispatched && writeConfirmed) {
        let after: SQLiteOccSnapshot | undefined;
        try {
          const rows = await this.readSQLiteOccRecord(transaction.server, schema, mutation.key);
          const expectedRows = mutation.operation === "delete" ? 0 : 1;
          if (rows.length === expectedRows) after = sqliteOccSnapshot(schema.table, schema.primaryKey, rows);
        } catch { /* The write succeeded, but its final state could not be captured. */ }
        if (this.snapshots && reserved) {
          try {
            if (after !== undefined) this.snapshots.complete(transaction.id, after, !containsSecretToken(beforeSnapshot) && !containsSecretToken(after));
            else this.snapshots.markUnavailable(transaction.id);
          } catch {
            try { this.snapshots.markUnavailable(transaction.id); } catch { /* Keep the durable audit authoritative. */ }
          }
          reserved = false;
        }
        const updated = this.staging.transition(transaction.id, "COMMITTED", {
          ...(after !== undefined ? { after } : {}),
          error: "SQLite reported the write as applied, but the post-change snapshot could not be verified; restore is unavailable.",
          errorCategory: "POST_EXECUTION_SNAPSHOT_FAILED",
        });
        this.changed();
        return updated;
      } else if (dispatched && !message.startsWith("STATE_CONFLICT:")) {
        let after: unknown;
        try {
          const rows = await this.readSQLiteOccRecord(transaction.server, schema, mutation.key);
          if (rows.length <= 1) after = sqliteOccSnapshot(schema.table, schema.primaryKey, rows);
          if (this.snapshots && reserved && after !== undefined) {
            this.snapshots.complete(transaction.id, after, !containsSecretToken(transaction.before) && !containsSecretToken(after));
            reserved = false;
          }
        } catch {
          /* The write may have happened; an unavailable post-read does not make retry safe. */
        }
        if (this.snapshots && reserved) {
          try { this.snapshots.markUnavailable(transaction.id); } catch { /* Keep the outcome conservative. */ }
          reserved = false;
        }
        this.staging.transition(transaction.id, "OUTCOME_UNKNOWN", {
          ...(after !== undefined ? { after } : {}),
          error: "The SQLite write was dispatched but its result could not be verified. Inspect upstream state before taking another action.",
          errorCategory: categorizeUpstreamError(error),
        });
      } else if (!stateUpdated) {
        if (this.snapshots && reserved) {
          try { this.snapshots.markUnavailable(transaction.id); } catch { /* No verified retained snapshot is available. */ }
          reserved = false;
        }
        this.staging.transition(transaction.id, "PENDING", {
          error: message,
          errorCategory: message.startsWith("STALE_SNAPSHOT:") || message.startsWith("STATE_CONFLICT:") ? "STATE_CONFLICT" : "SNAPSHOT_CHECK_FAILED",
        });
      }
      this.changed();
      throw new Error(message);
    }
  }

  private async restoreSQLiteOcc(transaction: StagedTransaction, markDispatched: () => void): Promise<void> {
    const intent = this.sqliteOccMutationFor(transaction);
    const schema = await this.verifySQLiteOccSchema(transaction.server, intent.table);
    if (!isSQLiteOccSnapshot(transaction.before) || !isSQLiteOccSnapshot(transaction.after) || transaction.before.rows.length !== 1 || transaction.after.rows.length > 1) {
      throw new Error("SQLITE_OCC_RESTORE_UNSUPPORTED: snapshots do not describe a single SQLite row.");
    }
    const before = validateSQLiteOccRow(transaction.before.rows[0], schema);
    const after = transaction.after.rows.length === 1 ? validateSQLiteOccRow(transaction.after.rows[0], schema) : undefined;
    const query = buildSQLiteOccRestoreQuery(schema, before, after);
    markDispatched();
    const affectedRows = await this.writeSQLiteOcc(transaction.server, query);
    if (affectedRows === 0) throw new Error("ROLLBACK_CONFLICT: the guarded SQLite restore matched no row; newer state was left unchanged.");
    if (affectedRows !== 1) throw new Error("SQLITE_OCC_RESTORE_INVARIANT: restore reported an unexpected affected_rows count.");
    const restoredRows = await this.readSQLiteOccRecord(transaction.server, schema, intent.key);
    if (restoredRows.length !== 1 || !sameSQLiteOccRow(restoredRows[0], before)) {
      throw new Error("SQLITE_OCC_RESTORE_UNVERIFIED: restore was dispatched but the original row state could not be confirmed.");
    }
  }

  async manageTransaction(id: string, action: "approve" | "reject" | "undo" | "list"): Promise<unknown> {
    if (action === "list") return this.staging.list().map(toolTransactionSummary);
    if (this.activeTransactions.has(id)) throw new Error("Transaction " + id + " is already being processed.");
    this.activeTransactions.add(id);
    let lockedServer: string | undefined;
    try {
      let transaction: StagedTransaction;
      let historical = false;
      if (action === "undo") {
        try {
          transaction = this.staging.get(id);
        } catch {
          const audit = this.staging.findAudit(id);
          const stored = this.snapshots?.lookup([id]).get(id);
          if (!audit || audit.sessionState !== "ENDED" || !stored?.snapshot || stored.state !== "READY" || !stored.snapshot.restorable ||
              (audit.status !== "COMMITTED" && audit.status !== "OUTCOME_UNKNOWN")) {
            throw new Error("SNAPSHOT_UNAVAILABLE: this transaction has no safely restorable retained snapshot.");
          }
          const serverConfig = this.config.servers.find((server) => server.name === audit.server);
          const snapshotPlan = serverConfig?.stagedTools?.[audit.tool];
          const sqlitePolicy = serverConfig?.sqliteOcc?.writeTool === audit.tool ? serverConfig.sqliteOcc : undefined;
          const currentPlanHash = snapshotPlan ? snapshotPlanHash(snapshotPlan) : sqlitePolicy ? sqliteOccPlanHash(sqlitePolicy) : undefined;
          if (!currentPlanHash || currentPlanHash !== stored.snapshot.planHash) {
            throw new Error("SNAPSHOT_PLAN_CHANGED: the configured snapshot or restore plan changed after this transaction; HyperMCP will not restore it.");
          }
          transaction = {
            id: audit.id,
            server: audit.server,
            tool: audit.tool,
            arguments: {},
            ...(snapshotPlan ? { snapshotPlan } : {}),
            before: stored.snapshot.before,
            after: stored.snapshot.after,
            status: audit.status,
            createdAt: audit.createdAt,
            updatedAt: audit.updatedAt,
            diffSummary: audit.diffSummary,
            affectedRows: audit.affectedRows,
            ...(audit.errorCategory ? { errorCategory: audit.errorCategory } : {}),
          };
          historical = true;
        }
      } else transaction = this.staging.get(id);
      if (action === "approve" || action === "undo") {
        if (this.activeServers.has(transaction.server)) throw new Error("UPSTREAM_BUSY: another transaction is changing " + transaction.server + ". Retry after it finishes.");
        this.activeServers.add(transaction.server);
        lockedServer = transaction.server;
      }
      if (action === "reject") {
        if (transaction.status !== "PENDING") throw new Error("Only pending transactions can be rejected.");
        const updated = this.staging.transition(id, "REJECTED", { error: undefined, errorCategory: undefined });
        this.changed();
        return updated;
      }
      if (action === "approve") {
        if (transaction.status !== "PENDING") throw new Error("Only pending transactions can be approved.");
        if (transaction.sqliteOccMutation) return await this.approveSQLiteOcc(transaction);
        if (!transaction.snapshotPlan) throw new Error("SNAPSHOT_PLAN_MISSING: transaction has no supported snapshot plan.");
        let mutationAttempted = false;
        let snapshotReserved = false;
        try {
          const current = await this.snapshot(transaction.server, transaction.snapshotPlan);
          if (JSON.stringify(current) !== JSON.stringify(transaction.before)) {
            const rows = findRows(current) ?? [];
            const affectedRows = /inactive/i.test(transaction.tool) ? rows.filter((row) => Number(row.inactive_days) > 90).length : Array.isArray(transaction.arguments.records) ? transaction.arguments.records.length : rows.length;
            const previewAfter = /(?:delete|remove).*inactive/i.test(transaction.tool)
              ? filterInactive(current)
              : Array.isArray(transaction.arguments.records) ? { rows: [...rows, ...transaction.arguments.records] } : current;
            const diffSummary = affectedRows + " row" + (affectedRows === 1 ? "" : "s") + " affected by " + transaction.tool;
            this.staging.transition(id, "PENDING", { before: current, previewAfter, affectedRows, diffSummary, error: "Upstream state changed after staging. Review this updated diff and approve again.", errorCategory: "STATE_CONFLICT" });
            this.changed();
            throw new Error("STALE_SNAPSHOT: review the updated diff and approve again.");
          }
          const args = this.hydrateForTool(transaction.server, transaction.tool, transaction.arguments) as JsonObject;
          if (this.snapshotRetentionEnabled && this.snapshots) {
            this.snapshots.reserve({
              id,
              server: transaction.server,
              tool: transaction.tool,
              planHash: this.transactionPlanHash(transaction),
              before: current,
            });
            snapshotReserved = true;
          }
          // The durable IN_FLIGHT write must succeed before the mutation can reach the upstream.
          this.staging.transition(id, "IN_FLIGHT", { error: undefined, errorCategory: undefined });
          this.changed();
          mutationAttempted = true;
          await this.callUpstreamRaw(transaction.server, transaction.tool, args);
          let afterSnapshot: unknown;
          try {
            const after = await this.snapshot(transaction.server, transaction.snapshotPlan);
            afterSnapshot = after;
            if (this.snapshots && snapshotReserved) {
              this.snapshots.complete(id, after, !containsSecretToken(current) && !containsSecretToken(after));
              snapshotReserved = false;
            }
          } catch (error) {
            if (this.snapshots && snapshotReserved) {
              try { this.snapshots.markUnavailable(id); } catch { /* The durable audit will still report that the post-state was not retained. */ }
              snapshotReserved = false;
            }
            const message = this.vault.scrubString(error instanceof Error ? error.message : String(error));
            const updated = this.staging.transition(id, "COMMITTED", {
              ...(afterSnapshot !== undefined ? { after: afterSnapshot } : {}),
              error: "Mutation applied, but the post-change snapshot could not be retained: " + message,
              errorCategory: "POST_EXECUTION_SNAPSHOT_FAILED",
            });
            this.changed();
            return updated;
          }
          const updated = this.staging.transition(id, "COMMITTED", { after: afterSnapshot, error: undefined, errorCategory: undefined });
          this.changed();
          return updated;
        } catch (error) {
          const message = this.vault.scrubString(error instanceof Error ? error.message : String(error));
          if (mutationAttempted) {
            let after: unknown;
            try {
              after = await this.snapshot(transaction.server, transaction.snapshotPlan);
              if (this.snapshots && snapshotReserved) {
                this.snapshots.complete(id, after, !containsSecretToken(transaction.before) && !containsSecretToken(after));
                snapshotReserved = false;
              }
            } catch {
              if (this.snapshots && snapshotReserved) {
                try { this.snapshots.markUnavailable(id); } catch { /* Keep the transaction outcome conservative. */ }
                snapshotReserved = false;
              }
              /* Outcome remains uncertain; never retry automatically. */
            }
            this.staging.transition(id, "OUTCOME_UNKNOWN", { ...(after !== undefined ? { after } : {}), error: "The upstream call failed after dispatch. Its outcome may be partial; inspect upstream state before taking another action. " + message, errorCategory: categorizeUpstreamError(error) });
          } else {
            if (this.snapshots && snapshotReserved) {
              try { this.snapshots.markUnavailable(id); } catch { /* No upstream write was dispatched. */ }
              snapshotReserved = false;
            }
            this.staging.transition(id, "PENDING", { error: message, errorCategory: message.includes("STALE_SNAPSHOT") ? "STATE_CONFLICT" : "SNAPSHOT_CHECK_FAILED" });
          }
          this.changed();
          throw new Error(message);
        }
      }
      if (transaction.status === "ROLLED_BACK") return transaction;
      if (transaction.status !== "COMMITTED" && transaction.status !== "OUTCOME_UNKNOWN") throw new Error("Only committed or outcome-unknown transactions can be rolled back.");
      if (transaction.after === undefined) throw new Error("The transaction has no verified post-call snapshot; inspect upstream state and recover it manually.");
      let restoreClaimed = false;
      if (this.snapshots && !historical) {
        const stored = this.snapshots.lookup([id]).get(id)?.snapshot;
        if (stored?.state === "READY" && stored.restorable) {
          const claimed = this.snapshots.claimRestore(id);
          if (claimed.planHash !== this.transactionPlanHash(transaction)) {
            this.snapshots.releaseRestore(id);
            throw new Error("SNAPSHOT_PLAN_CHANGED: the configured snapshot or restore plan changed; HyperMCP will not restore it.");
          }
          transaction = { ...transaction, before: claimed.before, after: claimed.after };
          restoreClaimed = true;
        }
      }
      if (historical) {
        const claimed = this.snapshots!.claimRestore(id);
        if (claimed.planHash !== this.transactionPlanHash(transaction)) {
          this.snapshots!.releaseRestore(id);
          throw new Error("SNAPSHOT_PLAN_CHANGED: the configured snapshot or restore plan changed; HyperMCP will not restore it.");
        }
        transaction = { ...transaction, before: claimed.before, after: claimed.after };
        restoreClaimed = true;
      }
      let restoreAttempted = false;
      const sqliteAdapter = Boolean(transaction.sqliteOccMutation || this.connections.get(transaction.server)?.config.sqliteOcc?.writeTool === transaction.tool);
      try {
        if (sqliteAdapter) {
          await this.verifySQLiteOccSchema(transaction.server, this.sqliteOccMutationFor(transaction).table);
          const current = await this.currentSQLiteOccSnapshot(transaction);
          if (!this.sameSQLiteOccSnapshot(transaction.after, current)) throw new Error("ROLLBACK_CONFLICT: upstream state changed after this transaction. HyperMCP will not overwrite newer data.");
        } else {
          if (!transaction.snapshotPlan) throw new Error("SNAPSHOT_PLAN_MISSING: transaction has no supported restore plan.");
          const current = await this.snapshot(transaction.server, transaction.snapshotPlan);
          if (JSON.stringify(current) !== JSON.stringify(transaction.after)) throw new Error("ROLLBACK_CONFLICT: upstream state changed after this transaction. HyperMCP will not overwrite newer data.");
        }
        if (!historical) {
          this.staging.transition(id, "IN_FLIGHT", { error: undefined, errorCategory: undefined });
          this.changed();
        }
        if (sqliteAdapter) {
          await this.restoreSQLiteOcc(transaction, () => { restoreAttempted = true; });
        } else {
          restoreAttempted = true;
          await this.rollback.restore(transaction);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const knownConflict = errorMessage.startsWith("ROLLBACK_CONFLICT:") && (!restoreAttempted || sqliteAdapter);
        if (restoreClaimed) {
          try {
            if (restoreAttempted && !knownConflict) this.snapshots!.markUnavailable(id);
            else this.snapshots!.releaseRestore(id);
          } catch { /* Recovery will mark a stranded restore unavailable on the next start. */ }
        }
        if (restoreAttempted && !knownConflict) {
          const category = categorizeUpstreamError(error);
          if (historical) this.staging.updateHistorical(id, "OUTCOME_UNKNOWN", category);
          else this.staging.transition(id, "OUTCOME_UNKNOWN", {
            error: "The restore call failed after dispatch. Upstream state may have changed; inspect it before taking further action.",
            errorCategory: category,
          });
          this.changed();
        } else if (!historical) {
          this.staging.transition(id, transaction.status, {
            error: knownConflict
              ? "The guarded restore found newer upstream state and changed nothing. The transaction remains available for review."
              : "The restore was not dispatched. Check the SQLite schema and upstream connection before retrying.",
            errorCategory: knownConflict ? "STATE_CONFLICT" : "SNAPSHOT_CHECK_FAILED",
          });
          this.changed();
        }
        throw error;
      }
      if (historical) {
        this.staging.updateHistorical(id, "ROLLED_BACK");
        if (restoreClaimed) {
          try { this.snapshots!.finishRestore(id); } catch { /* The journal status prevents another restore; cleanup can retry later. */ }
        }
        this.changed();
        return { ...transaction, status: "ROLLED_BACK", after: transaction.before, updatedAt: new Date().toISOString() };
      }
      const updated = this.staging.transition(id, "ROLLED_BACK", { after: transaction.before, error: undefined, errorCategory: undefined });
      if (restoreClaimed) {
        try { this.snapshots!.finishRestore(id); } catch { /* The journal status prevents another restore; cleanup can retry later. */ }
      }
      this.changed();
      return updated;
    } finally {
      if (lockedServer) this.activeServers.delete(lockedServer);
      this.activeTransactions.delete(id);
      if (this.activeTransactions.size === 0) {
        for (const resolve of this.transactionIdleWaiters) resolve();
        this.transactionIdleWaiters.clear();
      }
    }
  }

  getDashboardState(): unknown {
    const refs = this.sql.listReferences();
    const allTokens = refs.reduce((sum, ref) => sum + ref.originalTokens, 0);
    const saved = this.sql.totalTokensSaved;
    const lockStatus = this.schemaLock.getStatus();
    const auditHistory = this.staging.auditHistory();
    const storedSnapshots = this.snapshots?.lookup(auditHistory.entries.map((entry) => entry.id));
    const auditEntries = auditHistory.entries.map((entry) => {
      const stored = storedSnapshots?.get(entry.id);
      const snapshot = stored?.snapshot;
      if (!snapshot) {
        const snapshotState = stored?.state === "EXPIRED" ? "EXPIRED"
          : stored?.state === "RESTORED" ? "RESTORED"
            : stored ? "UNAVAILABLE" : "NOT_RETAINED";
        return { ...entry, snapshotState };
      }
      const serverConfig = this.config.servers.find((server) => server.name === entry.server);
      const plan = serverConfig?.stagedTools?.[entry.tool];
      const sqlitePlan = serverConfig?.sqliteOcc?.writeTool === entry.tool ? serverConfig.sqliteOcc : undefined;
      const planMatches = Boolean(plan && snapshotPlanHash(plan) === snapshot.planHash || sqlitePlan && sqliteOccPlanHash(sqlitePlan) === snapshot.planHash);
      const restoreAvailable = snapshot.state === "READY" && snapshot.restorable && planMatches && entry.sessionState === "ENDED" &&
        (entry.status === "COMMITTED" || entry.status === "OUTCOME_UNKNOWN");
      return {
        ...entry,
        auditOnly: false,
        snapshotAvailable: true,
        restoreAvailable,
        snapshotState: snapshot.state === "RESTORED" ? "RESTORED" : "AVAILABLE",
        snapshotLabel: entry.sessionState === "ACTIVE"
          ? "OTHER SESSION · DIFF RETAINED · RESTORE UNAVAILABLE"
          : restoreAvailable ? "PAST SESSION · SNAPSHOT RETAINED · RESTORE AVAILABLE"
            : "PAST SESSION · DIFF RETAINED · RESTORE UNAVAILABLE",
        snapshotExpiresAt: snapshot.expiresAt,
        before: dashboardSnapshot(this.vault.scrub(snapshot.before)),
        after: dashboardSnapshot(this.vault.scrub(snapshot.after)),
        ...(!planMatches ? { snapshotNotice: "The configured snapshot or restore plan has changed; restore is disabled." }
          : snapshot.state === "RESTORED" ? { snapshotNotice: "This retained snapshot was already restored; it cannot be applied again." }
            : !snapshot.restorable ? { snapshotNotice: "This snapshot contains redacted secret values and cannot be restored after a restart." } : {}),
      };
    });
    return {
      runtime: { name: "HyperMCP", version: "0.1.0", status: this.started ? "RUNNING" : "STARTING", dashboard_url: this.dashboard?.url },
      snapshotRetention: {
        enabled: this.snapshotRetentionEnabled,
        retentionHours: this.snapshotRetentionEnabled ? this.config.policies.snapshotRetentionHours : 0,
        maxStorageMb: this.snapshotRetentionEnabled ? this.config.policies.maxSnapshotStorageMb : 0,
      },
      metrics: {
        tokens_saved: saved,
        original_context_tokens: allTokens,
        token_reduction_pct: allTokens ? Number((saved / allTokens * 100).toFixed(1)) : 0,
        active_reference_tables: refs.length,
        secrets_vaulted: this.vault.size,
        blocked_rug_pulls: lockStatus.blockedTools,
      },
      references: refs,
      security: lockStatus,
      tools: this.router.list().map((tool) => ({ server: tool.server, name: tool.name, lock_status: tool.lockStatus, description: tool.description })),
      transactions: this.staging.list().map((transaction) => dashboardTransaction(transaction, (value) => this.vault.scrub(value))),
      auditHistory: { ...auditHistory, entries: auditEntries },
    };
  }

  getTransactionSnapshot(id: string): unknown {
    let snapshot: { before: unknown; after?: unknown; previewAfter?: unknown } | undefined;
    try {
      const transaction = this.staging.get(id);
      snapshot = { before: transaction.before, ...(transaction.after !== undefined ? { after: transaction.after } : {}), ...(transaction.previewAfter !== undefined ? { previewAfter: transaction.previewAfter } : {}) };
    } catch {
      const retained = this.snapshots?.get(id);
      if (retained) snapshot = { before: retained.before, ...(retained.after !== undefined ? { after: retained.after } : {}) };
    }
    if (!snapshot) throw new Error("Snapshot is unavailable or has expired.");
    const safeSnapshot = this.vault.scrub(snapshot);
    const encoded = JSON.stringify(safeSnapshot);
    if (encoded && Buffer.byteLength(encoded, "utf8") > 12 * 1024 * 1024) throw new Error("Full snapshot preview exceeds the dashboard response limit.");
    return { id, ...(safeSnapshot as Record<string, unknown>) };
  }

  subscribe(listener: () => void): () => void {
    this.on("state", listener);
    return () => this.off("state", listener);
  }

  private changed(): void {
    this.emit("state");
  }

  createMcpServer(): McpServer {
    const server = new McpServer({ name: "hypermcp", version: "0.1.0" });
    server.registerTool("hypermcp_search_tools", {
      description: "Search locally indexed upstream MCP tools. Returns only matching schemas and MCP-Lock status.",
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }),
    }, async ({ query, limit }) => textResult(await this.searchTools(query, limit)));
    server.registerTool("hypermcp_call_tool", {
      description: "Call a discovered upstream MCP tool through MCP-Lock, MCP-Stage, secret scrubbing, and output virtualization.",
      inputSchema: z.object({ server: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }),
    }, async ({ server: upstream, tool, arguments: args }) => textResult(await this.callTool({ server: upstream, tool, arguments: args as JsonObject })));
    server.registerTool("hypermcp_query_ref", {
      description: "Run read-only SQLite SELECT queries over one or more $ref data pointers.",
      inputSchema: z.object({ sql: z.string().min(1) }),
    }, async ({ sql }) => textResult(await this.queryReference(sql)));
    server.registerTool("hypermcp_pipe_data", {
      description: "Pipe SQL-selected rows from local $ref tables into an upstream MCP tool without returning the rows to the model.",
      inputSchema: z.object({
        source_sql: z.string().min(1), target_server: z.string(), target_tool: z.string(), target_arg_key: z.string(),
        batch_size: z.number().int().min(1).max(500).optional(),
      }),
    }, async (input) => textResult(await this.pipeData(input)));
    server.registerTool("hypermcp_tx_manage", {
      description: "List staged and committed transactions. Human approval, rejection, and rollback are available in the local dashboard.",
      inputSchema: z.object({ action: z.literal("list") }),
    }, async () => textResult(await this.manageTransaction("", "list")));
    return server;
  }

  get dashboardUrl(): string | undefined {
    return this.dashboard?.url;
  }

  private async closeUpstreams(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.client.close()));
    this.connections.clear();
  }

  private async waitForTransactions(): Promise<void> {
    if (this.activeTransactions.size === 0) return;
    await new Promise<void>((resolve) => this.transactionIdleWaiters.add(resolve));
  }

  async close(): Promise<void> {
    await this.dashboard?.close();
    this.dashboard = undefined;
    await this.closeUpstreams();
    await this.waitForTransactions();
    this.sql.close();
    this.snapshots?.close();
    this.staging.close();
    this.started = false;
  }
}
