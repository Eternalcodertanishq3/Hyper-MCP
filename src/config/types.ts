export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;

export interface SnapshotPlan {
  tool: string;
  arguments: JsonObject;
  restoreTool: string;
  restoreArgumentKey: string;
}

export type SQLiteOccValue = string | number | null;
export type SQLiteOccMutation =
  | { operation: "update"; table: string; primaryKey: string; key: string | number; assignments: Record<string, SQLiteOccValue> }
  | { operation: "delete"; table: string; primaryKey: string; key: string | number };

export interface SQLiteOccTableConfig {
  name: string;
  primaryKey: string;
  allowedColumns: string[];
}

export interface SQLiteOccConfig {
  readTool: string;
  writeTool: string;
  readArgumentKey: string;
  writeArgumentKey: string;
  tables: SQLiteOccTableConfig[];
}

export interface SQLiteOccSchema {
  table: string;
  primaryKey: string;
  columns: string[];
}

export interface SQLiteOccSnapshot {
  table: string;
  primaryKey: string;
  rows: Record<string, SQLiteOccValue>[];
}

export interface UpstreamServerConfig {
  name: string;
  transport?: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  env?: Record<string, string>;
  /** Trusted, explicitly read-only tools. Unknown tools fail closed. */
  readOnlyTools?: string[];
  /** Mutating tools with exact per-tool snapshot and restore procedures. */
  stagedTools?: Record<string, SnapshotPlan>;
  /** Optional SQLite-only OCC policy for a server implementing HyperMCP's structured query contract. */
  sqliteOcc?: SQLiteOccConfig;
  /** Snapshot and restore tools unavailable to the model. */
  internalTools?: string[];
  /** Targets allowed to receive hydrated secrets through the data pipe. */
  secretHydrationTools?: string[];
}

export interface HyperMCPPolicies {
  virtualizeThresholdTokens: number;
  searchLimit: number;
  maskEmails: boolean;
  /** Cross-restart snapshot retention; zero disables payload persistence. */
  snapshotRetentionHours: number;
  /** Maximum logical snapshot payload bytes retained on disk. */
  maxSnapshotStorageMb: number;
}

export interface HyperMCPConfig {
  dashboardPort: number;
  lockFile: string;
  servers: UpstreamServerConfig[];
  policies: HyperMCPPolicies;
}

export interface IndexedTool {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  lockStatus: "VERIFIED" | "BLOCKED_RUG_PULL";
  lockReason?: string;
}

export interface ReferenceTableInfo {
  pointer: string;
  table: string;
  rowCount: number;
  schema: Record<string, string>;
  createdAt: string;
  originalTokens: number;
  virtualizedTokens: number;
}

export type TransactionStatus = "PENDING" | "IN_FLIGHT" | "COMMITTED" | "OUTCOME_UNKNOWN" | "EXPIRED_UNAPPROVED" | "REJECTED" | "ROLLED_BACK";

export type AuditErrorCategory =
  | "UPSTREAM_EXECUTION_ERROR"
  | "NETWORK_TIMEOUT"
  | "STATE_CONFLICT"
  | "DISPATCH_INTERRUPTED"
  | "SNAPSHOT_CHECK_FAILED"
  | "POST_EXECUTION_SNAPSHOT_FAILED";

export interface StagedTransaction {
  id: string;
  server: string;
  tool: string;
  arguments: JsonObject;
  snapshotPlan?: SnapshotPlan;
  /** Ephemeral write intent; raw payloads remain session-only unless snapshot retention is explicitly enabled. */
  sqliteOccMutation?: SQLiteOccMutation;
  before: unknown;
  previewAfter?: unknown;
  after?: unknown;
  status: TransactionStatus;
  createdAt: string;
  updatedAt: string;
  diffSummary: string;
  affectedRows: number;
  error?: string;
  errorCategory?: AuditErrorCategory;
}

export interface SecurityEvent {
  id: string;
  type: "RUG_PULL_BLOCKED" | "SCHEMA_LOCK_INITIALIZED";
  server: string;
  tool: string;
  message: string;
  createdAt: string;
}
