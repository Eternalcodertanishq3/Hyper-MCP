import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_TRANSACTION_SNAPSHOT_BYTES = MAX_SNAPSHOT_BYTES * 2;

export type SnapshotState = "RESERVED" | "READY" | "RESTORING" | "RESTORED" | "EXPIRED" | "UNAVAILABLE";

interface SnapshotStoreOptions {
  databasePath: string;
  sessionId: string;
  pid: number;
  enabled: boolean;
  retentionHours: number;
  quotaBytes: number;
  isSessionActive: (sessionId: string) => boolean;
  onInterruptedRestore: (id: string) => void;
}

export interface PersistentSnapshot {
  id: string;
  server: string;
  tool: string;
  planHash: string;
  state: SnapshotState;
  before: unknown;
  after?: unknown;
  restorable: boolean;
  expiresAt: string;
  sizeBytes: number;
}

export interface SnapshotLookup {
  state: SnapshotState;
  snapshot?: PersistentSnapshot;
}

interface SnapshotRow {
  id: string;
  server: string;
  tool: string;
  plan_hash: string;
  state: SnapshotState;
  before_json: string | null;
  after_json: string | null;
  restorable: number;
  expires_at: string;
  size_bytes: number;
  reserved_bytes: number;
  session_id: string;
  pid: number;
}

function serialize(value: unknown): { json: string; bytes: number } {
  let json: string | undefined;
  try { json = JSON.stringify(value ?? null); } catch { throw new Error("SNAPSHOT_SERIALIZATION_FAILED: snapshot is not JSON serializable."); }
  if (json === undefined) throw new Error("SNAPSHOT_SERIALIZATION_FAILED: snapshot is not JSON serializable.");
  return { json, bytes: Buffer.byteLength(json, "utf8") };
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

function prepareDatabasePath(databasePath: string): void {
  const directory = path.dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let exists = false;
  try {
    const info = lstatSync(databasePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("HyperMCP snapshot database path must be a regular file, not a symbolic link.");
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = lstatSync(databasePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("HyperMCP snapshot database path must be a regular file, not a symbolic link.");
      chmodSync(databasePath, 0o600);
    }
  }
}

function rowToSnapshot(row: SnapshotRow): PersistentSnapshot | undefined {
  if ((row.state !== "READY" && row.state !== "RESTORING" && row.state !== "RESTORED") || row.before_json === null || row.after_json === null) return undefined;
  return {
    id: row.id,
    server: row.server,
    tool: row.tool,
    planHash: row.plan_hash,
    state: row.state,
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
    restorable: row.restorable === 1,
    expiresAt: row.expires_at,
    sizeBytes: Number(row.size_bytes),
  };
}

/** Opt-in, bounded storage for scrubbed snapshot payloads. The payload database is separate from the audit journal. */
export class SnapshotStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: SnapshotStoreOptions) {
    if (!Number.isSafeInteger(options.retentionHours) || options.retentionHours < (options.enabled ? 1 : 0) || options.retentionHours > 720) {
      throw new Error("Snapshot retention must be between 1 and 720 hours when snapshot persistence is enabled.");
    }
    if (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < MAX_TRANSACTION_SNAPSHOT_BYTES) {
      throw new Error("Snapshot payload quota must be at least 10 MiB.");
    }
    this.databasePath = path.resolve(options.databasePath);
    prepareDatabasePath(this.databasePath);
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;");
      this.migrate();
      this.recoverInterruptedSnapshots();
      this.purgeInactiveSnapshots();
      this.expireDueSnapshots();
      this.secureDatabaseFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.timer = setInterval(() => {
      try {
        this.expireDueSnapshots();
        this.purgeInactiveSnapshots();
      } catch { /* Cleanup is retried on the next pass and every API read. */ }
    }, 60_000);
    this.timer.unref();
  }

  private secureDatabaseFiles(): void {
    if (process.platform === "win32") return;
    chmodSync(path.dirname(this.databasePath), 0o700);
    for (const filename of [this.databasePath, this.databasePath + "-wal", this.databasePath + "-shm"]) {
      try {
        const info = lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("HyperMCP snapshot database files must be regular files.");
        chmodSync(filename, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const versionRow = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      const version = Number(versionRow.user_version);
      if (version > 1) throw new Error("HyperMCP snapshot store schema is newer than this runtime supports.");
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE snapshot_records (
            id TEXT PRIMARY KEY,
            server TEXT NOT NULL,
            tool TEXT NOT NULL,
            plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
            state TEXT NOT NULL CHECK (state IN ('RESERVED','READY','RESTORING','RESTORED','EXPIRED','UNAVAILABLE')),
            before_json TEXT,
            after_json TEXT,
            restorable INTEGER NOT NULL DEFAULT 0 CHECK (restorable IN (0,1)),
            size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
            reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
            expires_at TEXT NOT NULL,
            session_id TEXT NOT NULL,
            pid INTEGER NOT NULL CHECK (pid > 0),
            updated_at TEXT NOT NULL
          );
          CREATE INDEX snapshot_records_expiry ON snapshot_records(state, expires_at);
          PRAGMA user_version = 1;
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ }
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = operation();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    this.secureDatabaseFiles();
    return result;
  }

  private expireDueSnapshots(): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    const changed = this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE snapshot_records SET state = 'EXPIRED', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ?
        WHERE state IN ('RESERVED','READY','RESTORING','RESTORED') AND expires_at <= ?
      `).run(now, now);
      return Number(result.changes);
    });
    if (changed) this.checkpointAfterPurge();
  }

  private checkpointAfterPurge(): void {
    try { this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { /* Another active reader may hold the WAL; secure_delete and later checkpoints still apply. */ }
    this.secureDatabaseFiles();
  }

  private recoverInterruptedSnapshots(): void {
    const now = new Date().toISOString();
    const rows = this.db.prepare("SELECT id, state, pid, session_id FROM snapshot_records WHERE state IN ('RESERVED','RESTORING')").all() as unknown as Array<{ id: string; state: SnapshotState; pid: number; session_id: string }>;
    const interrupted = rows.filter((row) => !this.options.isSessionActive(row.session_id) || !processIsAlive(Number(row.pid)));
    if (!interrupted.length) return;
    for (const row of interrupted) if (row.state === "RESTORING") this.options.onInterruptedRestore(row.id);
    const changed = this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE snapshot_records SET state = 'UNAVAILABLE', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ? WHERE id = ? AND state = ?
      `);
      let count = 0;
      for (const row of interrupted) count += Number(stmt.run(now, row.id, row.state).changes);
      return count;
    });
    if (changed) this.checkpointAfterPurge();
  }

  private purgeInactiveSnapshots(): void {
    if (this.options.enabled || this.closed) return;
    const rows = this.db.prepare("SELECT id, session_id FROM snapshot_records WHERE state IN ('RESERVED','READY','RESTORING','RESTORED')")
      .all() as unknown as Array<{ id: string; session_id: string }>;
    const inactive = rows.filter((row) => !this.options.isSessionActive(row.session_id));
    if (!inactive.length) return;
    const now = new Date().toISOString();
    const changed = this.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE snapshot_records SET state = 'UNAVAILABLE', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ? WHERE id = ?
      `);
      let count = 0;
      for (const row of inactive) count += Number(stmt.run(now, row.id).changes);
      return count;
    });
    if (changed) this.checkpointAfterPurge();
  }

  reserve(input: { id: string; server: string; tool: string; planHash: string; before: unknown }): void {
    if (this.closed) throw new Error("HyperMCP snapshot store is closed.");
    if (!this.options.enabled) throw new Error("SNAPSHOT_RETENTION_DISABLED: cross-restart snapshot retention is disabled.");
    const before = serialize(input.before);
    if (before.bytes > MAX_SNAPSHOT_BYTES) throw new Error("SNAPSHOT_TOO_LARGE: retained snapshots are limited to 5 MiB before and 5 MiB after.");
    if (!/^[a-f0-9]{64}$/.test(input.planHash)) throw new Error("SNAPSHOT_PLAN_INVALID: could not validate the configured snapshot plan.");
    const now = new Date();
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.options.retentionHours * 60 * 60 * 1000).toISOString();
    try {
      this.transaction(() => {
        this.db.prepare(`
        UPDATE snapshot_records SET state = 'EXPIRED', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ?
        WHERE state IN ('RESERVED','READY','RESTORING','RESTORED') AND expires_at <= ?
      `).run(timestamp, timestamp);
        const abandoned = this.db.prepare("SELECT id, pid, session_id FROM snapshot_records WHERE state = 'RESERVED'").all() as unknown as Array<{ id: string; pid: number; session_id: string }>;
        const release = this.db.prepare(`
        UPDATE snapshot_records SET state = 'UNAVAILABLE', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ? WHERE id = ? AND state = 'RESERVED'
      `);
        for (const row of abandoned) if (!this.options.isSessionActive(row.session_id) || !processIsAlive(Number(row.pid))) release.run(timestamp, row.id);

        const usedRow = this.db.prepare("SELECT COALESCE(SUM(size_bytes + reserved_bytes), 0) AS used FROM snapshot_records WHERE state IN ('RESERVED','READY','RESTORING','RESTORED')").get() as { used: number };
        if (Number(usedRow.used) + MAX_TRANSACTION_SNAPSHOT_BYTES > this.options.quotaBytes) {
          throw new Error("SNAPSHOT_QUOTA_EXCEEDED: retained snapshot quota is full; the upstream mutation was not dispatched.");
        }
        try {
          this.db.prepare(`
          INSERT INTO snapshot_records (id, server, tool, plan_hash, state, before_json, restorable, size_bytes,
            reserved_bytes, expires_at, session_id, pid, updated_at)
          VALUES (?, ?, ?, ?, 'RESERVED', ?, 0, ?, ?, ?, ?, ?, ?)
        `).run(input.id, input.server, input.tool, input.planHash, before.json, before.bytes,
            MAX_TRANSACTION_SNAPSHOT_BYTES - before.bytes, expiresAt, this.options.sessionId, this.options.pid, timestamp);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_PRIMARYKEY" || String(error).includes("UNIQUE constraint failed")) {
            const replaced = this.db.prepare(`
              UPDATE snapshot_records SET server = ?, tool = ?, plan_hash = ?, state = 'RESERVED', before_json = ?,
                after_json = NULL, restorable = 0, size_bytes = ?, reserved_bytes = ?, expires_at = ?,
                session_id = ?, pid = ?, updated_at = ?
              WHERE id = ? AND state IN ('UNAVAILABLE','EXPIRED')
            `).run(input.server, input.tool, input.planHash, before.json, before.bytes,
              MAX_TRANSACTION_SNAPSHOT_BYTES - before.bytes, expiresAt, this.options.sessionId, this.options.pid, timestamp, input.id);
            if (Number(replaced.changes) !== 1) throw new Error("SNAPSHOT_ALREADY_EXISTS: transaction already has a retained snapshot reservation.");
          } else {
            throw error;
          }
        }
      });
    } catch (error) {
      try { this.markUnavailable(input.id); } catch { /* Fail closed even if cleanup also encounters a storage failure. */ }
      throw error;
    }
  }

  complete(id: string, afterValue: unknown, restorable: boolean): void {
    if (this.closed) throw new Error("HyperMCP snapshot store is closed.");
    const after = serialize(afterValue);
    if (after.bytes > MAX_SNAPSHOT_BYTES) throw new Error("SNAPSHOT_TOO_LARGE: retained snapshots are limited to 5 MiB before and 5 MiB after.");
    const now = new Date().toISOString();
    this.transaction(() => {
      const row = this.db.prepare("SELECT before_json, state, expires_at FROM snapshot_records WHERE id = ?").get(id) as { before_json: string | null; state: SnapshotState; expires_at: string } | undefined;
      if (!row || row.state !== "RESERVED" || row.before_json === null || row.expires_at <= now) {
        throw new Error("SNAPSHOT_RESERVATION_LOST: mutation completed, but its retained snapshot reservation is unavailable.");
      }
      const beforeBytes = Buffer.byteLength(row.before_json, "utf8");
      const totalBytes = beforeBytes + after.bytes;
      if (totalBytes > MAX_TRANSACTION_SNAPSHOT_BYTES) throw new Error("SNAPSHOT_TOO_LARGE: retained snapshots are limited to 10 MiB per transaction.");
      const result = this.db.prepare(`
        UPDATE snapshot_records SET state = 'READY', after_json = ?, restorable = ?, size_bytes = ?,
          reserved_bytes = 0, updated_at = ? WHERE id = ? AND state = 'RESERVED'
      `).run(after.json, restorable ? 1 : 0, totalBytes, now, id);
      if (Number(result.changes) !== 1) throw new Error("SNAPSHOT_RESERVATION_LOST: could not finalize the retained snapshot.");
    });
  }

  markUnavailable(id: string): void {
    if (this.closed) return;
    const now = new Date().toISOString();
    const changed = this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE snapshot_records SET state = 'UNAVAILABLE', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ? WHERE id = ? AND state <> 'EXPIRED'
      `).run(now, id);
      return Number(result.changes);
    });
    if (changed) this.checkpointAfterPurge();
  }

  get(id: string): PersistentSnapshot | undefined {
    if (this.closed) throw new Error("HyperMCP snapshot store is closed.");
    this.purgeInactiveSnapshots();
    this.expireDueSnapshots();
    const row = this.db.prepare("SELECT * FROM snapshot_records WHERE id = ?").get(id) as unknown as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : undefined;
  }

  lookup(ids: string[]): Map<string, SnapshotLookup> {
    if (this.closed) throw new Error("HyperMCP snapshot store is closed.");
    const results = new Map<string, SnapshotLookup>();
    if (!ids.length) return results;
    this.purgeInactiveSnapshots();
    this.expireDueSnapshots();
    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db.prepare("SELECT * FROM snapshot_records WHERE id IN (" + placeholders + ")").all(...uniqueIds) as unknown as SnapshotRow[];
    for (const row of rows) {
      const snapshot = rowToSnapshot(row);
      results.set(row.id, { state: row.state, ...(snapshot ? { snapshot } : {}) });
    }
    return results;
  }

  state(id: string): SnapshotState | undefined {
    if (this.closed) throw new Error("HyperMCP snapshot store is closed.");
    this.purgeInactiveSnapshots();
    this.expireDueSnapshots();
    const row = this.db.prepare("SELECT state FROM snapshot_records WHERE id = ?").get(id) as { state: SnapshotState } | undefined;
    return row?.state;
  }

  claimRestore(id: string): PersistentSnapshot {
    if (this.closed) throw new Error("HyperMCP snapshot store is closed.");
    let snapshot: PersistentSnapshot | undefined;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE snapshot_records SET state = 'EXPIRED', before_json = NULL, after_json = NULL,
          restorable = 0, size_bytes = 0, reserved_bytes = 0, updated_at = ?
        WHERE id = ? AND state = 'READY' AND expires_at <= ?
      `).run(now, id, now);
      const row = this.db.prepare("SELECT * FROM snapshot_records WHERE id = ?").get(id) as unknown as SnapshotRow | undefined;
      snapshot = row ? rowToSnapshot(row) : undefined;
      if (!snapshot || row?.state !== "READY" || !snapshot.restorable) throw new Error("SNAPSHOT_UNAVAILABLE: this retained snapshot is expired, unavailable, or cannot be restored safely.");
      const result = this.db.prepare("UPDATE snapshot_records SET state = 'RESTORING', updated_at = ? WHERE id = ? AND state = 'READY'").run(now, id);
      if (Number(result.changes) !== 1) throw new Error("SNAPSHOT_BUSY: another HyperMCP process is already restoring this snapshot.");
      snapshot = { ...snapshot, state: "RESTORING", restorable: false };
    });
    return snapshot!;
  }

  releaseRestore(id: string): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE snapshot_records SET state = 'READY', updated_at = ? WHERE id = ? AND state = 'RESTORING'").run(now, id);
    });
  }

  finishRestore(id: string): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE snapshot_records SET state = 'RESTORED', updated_at = ? WHERE id = ? AND state = 'RESTORING'").run(now, id);
    });
  }

  close(): void {
    if (this.closed) return;
    clearInterval(this.timer);
    this.db.close();
    this.closed = true;
  }
}
