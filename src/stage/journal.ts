import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditErrorCategory, TransactionStatus } from "../config/types.ts";

const SCHEMA_VERSION = 2;
const HISTORY_LIMIT = 500;
const VALID_STATUSES: TransactionStatus[] = [
  "PENDING", "IN_FLIGHT", "COMMITTED", "OUTCOME_UNKNOWN", "EXPIRED_UNAPPROVED", "REJECTED", "ROLLED_BACK",
];
const VALID_ERROR_CATEGORIES: AuditErrorCategory[] = [
  "UPSTREAM_EXECUTION_ERROR", "NETWORK_TIMEOUT", "STATE_CONFLICT", "DISPATCH_INTERRUPTED",
  "SNAPSHOT_CHECK_FAILED", "POST_EXECUTION_SNAPSHOT_FAILED",
];

export interface JournalWrite {
  id: string;
  server: string;
  tool: string;
  status: TransactionStatus;
  diffSummary: string;
  affectedRows: number;
  createdAt: string;
  updatedAt: string;
  errorCategory?: AuditErrorCategory;
}

export interface AuditJournalEntry {
  id: string;
  server: string;
  tool: string;
  status: TransactionStatus;
  diffSummary: string;
  affectedRows: number;
  createdAt: string;
  updatedAt: string;
  errorCategory?: AuditErrorCategory;
  auditOnly: boolean;
  snapshotAvailable: boolean;
  restoreAvailable: boolean;
  snapshotState: "AVAILABLE" | "EXPIRED" | "NOT_RETAINED" | "RESTORED" | "UNAVAILABLE";
  snapshotExpiresAt?: string;
  before?: unknown;
  after?: unknown;
  sessionState: "ACTIVE" | "ENDED";
  sessionStartedAt: string;
}

export interface AuditJournalHistory {
  entries: AuditJournalEntry[];
  total: number;
  truncated: boolean;
}

interface JournalOptions {
  path?: string;
  sessionId?: string;
  pid?: number;
  /** Injectable process liveness check, primarily useful for crash-recovery tests. */
  isProcessAlive?: (pid: number) => boolean;
}

interface SessionRow {
  session_id: string;
  pid: number;
  started_at: string;
  ended_at: string | null;
}

interface EntryRow {
  id: string;
  server: string;
  tool: string;
  status: TransactionStatus;
  diff_summary: string;
  affected_rows: number;
  created_at: string;
  updated_at: string;
  error_category: AuditErrorCategory | null;
  session_state: "ACTIVE" | "ENDED";
  session_started_at: string;
}

export function defaultJournalPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const configuredDirectory = env.HYPERMCP_DATA_DIR;
  if (configuredDirectory?.trim()) return path.resolve(configuredDirectory, "audit.sqlite");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.join(localAppData, "hypermcp", "audit.sqlite");
  }
  return path.join(home, ".hypermcp", "audit.sqlite");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeMetadata(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maxLength);
}

function prepareDatabasePath(databasePath: string): void {
  const directory = path.dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let exists = false;
  try {
    const info = lstatSync(databasePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("HyperMCP audit journal path must be a regular file, not a symbolic link.");
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (process.platform === "win32") return;
  chmodSync(directory, 0o700);

  if (exists) chmodSync(databasePath, 0o600);
  else {
    try {
      const descriptor = openSync(databasePath, "wx", 0o600);
      closeSync(descriptor);
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      const info = lstatSync(databasePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("HyperMCP audit journal path must be a regular file, not a symbolic link.");
      chmodSync(databasePath, 0o600);
    }
  }

  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = databasePath + suffix;
    try {
      const info = lstatSync(sidecar);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("HyperMCP audit journal sidecar must be a regular file.");
      chmodSync(sidecar, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function entryFromRow(row: EntryRow): AuditJournalEntry {
  return {
    id: row.id,
    server: row.server,
    tool: row.tool,
    status: row.status,
    diffSummary: row.diff_summary,
    affectedRows: Number(row.affected_rows),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error_category ? { errorCategory: row.error_category } : {}),
    auditOnly: true,
    snapshotAvailable: false,
    restoreAvailable: false,
    snapshotState: "NOT_RETAINED",
    sessionState: row.session_state,
    sessionStartedAt: row.session_started_at,
  };
}

/** Durable local metadata only. Tool arguments, snapshots, and upstream error text never enter this database. */
export class TransactionJournal {
  readonly sessionId: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private closed = false;

  constructor(options: JournalOptions = {}) {
    this.databasePath = path.resolve(options.path ?? defaultJournalPath());
    this.sessionId = options.sessionId ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isProcessAlive ?? processIsAlive;
    prepareDatabasePath(this.databasePath);
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      this.migrate();
      this.recoverAbandonedSessions();
      this.db.prepare("INSERT INTO runtime_sessions (session_id, pid, started_at, ended_at) VALUES (?, ?, ?, NULL)")
        .run(this.sessionId, this.pid, new Date().toISOString());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const version = Number(versionRow.user_version);
    if (version > SCHEMA_VERSION) throw new Error("HyperMCP audit journal schema is newer than this runtime supports.");
    if (version === SCHEMA_VERSION) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_sessions (
          session_id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL CHECK (pid > 0),
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_entries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
          server TEXT NOT NULL CHECK (length(server) <= 128),
          tool TEXT NOT NULL CHECK (length(tool) <= 256),
          status TEXT NOT NULL CHECK (status IN ('PENDING','IN_FLIGHT','COMMITTED','OUTCOME_UNKNOWN','EXPIRED_UNAPPROVED','REJECTED','ROLLED_BACK')),
          diff_summary TEXT NOT NULL CHECK (length(diff_summary) <= 96),
          affected_rows INTEGER NOT NULL CHECK (affected_rows >= 0),
          error_category TEXT CHECK (error_category IS NULL OR error_category IN ('UPSTREAM_EXECUTION_ERROR','NETWORK_TIMEOUT','STATE_CONFLICT','DISPATCH_INTERRUPTED','SNAPSHOT_CHECK_FAILED','POST_EXECUTION_SNAPSHOT_FAILED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_entries_session_created ON audit_entries(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS audit_entries_status_session ON audit_entries(status, session_id);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private recoverAbandonedSessions(): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT s.session_id, s.pid, s.started_at, s.ended_at
      FROM runtime_sessions s
      WHERE s.session_id <> ? AND (
        s.ended_at IS NULL OR EXISTS (
          SELECT 1 FROM audit_entries a WHERE a.session_id = s.session_id AND a.status IN ('PENDING', 'IN_FLIGHT')
        )
      )
    `).all(this.sessionId) as unknown as SessionRow[];
    const abandoned = rows.filter((row) => row.ended_at !== null || !this.isAlive(Number(row.pid)));
    if (!abandoned.length) return;

    const recoveredAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expirePending = this.db.prepare("UPDATE audit_entries SET status = 'EXPIRED_UNAPPROVED', updated_at = ?, error_category = NULL WHERE session_id = ? AND status = 'PENDING'");
      const markInterrupted = this.db.prepare("UPDATE audit_entries SET status = 'OUTCOME_UNKNOWN', updated_at = ?, error_category = 'DISPATCH_INTERRUPTED' WHERE session_id = ? AND status = 'IN_FLIGHT'");
      const endSession = this.db.prepare("UPDATE runtime_sessions SET ended_at = COALESCE(ended_at, ?) WHERE session_id = ?");
      for (const session of abandoned) {
        expirePending.run(recoveredAt, session.session_id);
        markInterrupted.run(recoveredAt, session.session_id);
        endSession.run(recoveredAt, session.session_id);
      }
      this.db.prepare("DELETE FROM runtime_sessions WHERE ended_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audit_entries WHERE audit_entries.session_id = runtime_sessions.session_id)").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  record(entry: JournalWrite): void {
    if (this.closed) throw new Error("HyperMCP audit journal is closed.");
    if (!VALID_STATUSES.includes(entry.status)) throw new Error("Invalid transaction status for audit journal.");
    if (entry.errorCategory && !VALID_ERROR_CATEGORIES.includes(entry.errorCategory)) throw new Error("Invalid error category for audit journal.");
    const affectedRows = Number.isSafeInteger(entry.affectedRows) ? Math.max(0, entry.affectedRows) : 0;
    const diffSummary = affectedRows + " row" + (affectedRows === 1 ? "" : "s") + " affected";
    const result = this.db.prepare(`
      INSERT INTO audit_entries (id, session_id, server, tool, status, diff_summary, affected_rows, error_category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        diff_summary = excluded.diff_summary,
        affected_rows = excluded.affected_rows,
        error_category = excluded.error_category,
        updated_at = excluded.updated_at
      WHERE audit_entries.session_id = excluded.session_id
    `).run(
      entry.id,
      this.sessionId,
      safeMetadata(entry.server, 128),
      safeMetadata(entry.tool, 256),
      entry.status,
      diffSummary.slice(0, 96),
      affectedRows,
      entry.errorCategory ?? null,
      entry.createdAt,
      entry.updatedAt,
    );
    if (Number(result.changes) !== 1) throw new Error("Could not persist HyperMCP transaction metadata.");
  }

  history(): AuditJournalHistory {
    if (this.closed) throw new Error("HyperMCP audit journal is closed.");
    this.recoverAbandonedSessions();
    const countRow = this.db.prepare("SELECT COUNT(*) AS total FROM audit_entries WHERE session_id <> ?").get(this.sessionId) as { total: number };
    const total = Number(countRow.total);
    const rows = this.db.prepare(`
      SELECT a.id, a.server, a.tool, a.status, a.diff_summary, a.affected_rows, a.created_at, a.updated_at,
        a.error_category, CASE WHEN s.ended_at IS NULL THEN 'ACTIVE' ELSE 'ENDED' END AS session_state,
        s.started_at AS session_started_at
      FROM audit_entries a
      JOIN runtime_sessions s ON s.session_id = a.session_id
      WHERE a.session_id <> ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `).all(this.sessionId, HISTORY_LIMIT) as unknown as EntryRow[];
    return { entries: rows.map(entryFromRow), total, truncated: total > rows.length };
  }

  find(id: string): AuditJournalEntry | undefined {
    if (this.closed) throw new Error("HyperMCP audit journal is closed.");
    const row = this.db.prepare(`
      SELECT a.id, a.server, a.tool, a.status, a.diff_summary, a.affected_rows, a.created_at, a.updated_at,
        a.error_category, CASE WHEN s.ended_at IS NULL THEN 'ACTIVE' ELSE 'ENDED' END AS session_state,
        s.started_at AS session_started_at
      FROM audit_entries a JOIN runtime_sessions s ON s.session_id = a.session_id WHERE a.id = ?
    `).get(id) as unknown as EntryRow | undefined;
    return row ? entryFromRow(row) : undefined;
  }

  updateExisting(id: string, status: TransactionStatus, errorCategory?: AuditErrorCategory): void {
    if (this.closed) throw new Error("HyperMCP audit journal is closed.");
    if (!VALID_STATUSES.includes(status)) throw new Error("Invalid transaction status for audit journal.");
    if (errorCategory && !VALID_ERROR_CATEGORIES.includes(errorCategory)) throw new Error("Invalid error category for audit journal.");
    const result = this.db.prepare("UPDATE audit_entries SET status = ?, error_category = ?, updated_at = ? WHERE id = ?")
      .run(status, errorCategory ?? null, new Date().toISOString(), id);
    if (Number(result.changes) !== 1) throw new Error("Could not update HyperMCP transaction metadata.");
  }

  isSessionActive(sessionId: string): boolean {
    if (this.closed) return false;
    const row = this.db.prepare("SELECT ended_at FROM runtime_sessions WHERE session_id = ?").get(sessionId) as { ended_at: string | null } | undefined;
    return row?.ended_at === null;
  }

  close(): void {
    if (this.closed) return;
    this.db.prepare("UPDATE runtime_sessions SET ended_at = COALESCE(ended_at, ?) WHERE session_id = ?")
      .run(new Date().toISOString(), this.sessionId);
    this.db.prepare("DELETE FROM runtime_sessions WHERE session_id = ? AND NOT EXISTS (SELECT 1 FROM audit_entries WHERE audit_entries.session_id = runtime_sessions.session_id)")
      .run(this.sessionId);
    this.db.close();
    this.closed = true;
  }
}
