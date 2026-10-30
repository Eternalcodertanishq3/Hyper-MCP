import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StagingManager } from "../src/stage/stagingManager.ts";
import { TransactionJournal } from "../src/stage/journal.ts";

const input = (tool: string) => ({
  server: "postgres",
  tool,
  arguments: { records: [{ email: "private@example.test", api_key: "do-not-store" }] },
  snapshotPlan: { tool: "pg_snapshot", arguments: {}, restoreTool: "pg_restore", restoreArgumentKey: "records" },
  before: [{ email: "private@example.test" }],
  affectedRows: 1,
});

test("dead-session recovery expires pending records and marks in-flight records outcome unknown", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".hypermcp-journal-"));
  const databasePath = path.join(directory, "audit.sqlite");
  let previous: TransactionJournal | undefined;
  let current: TransactionJournal | undefined;
  try {
    // A fake, non-live owner models a process that was terminated without closing SQLite.
    previous = new TransactionJournal({ path: databasePath, pid: 2_147_483_647, isProcessAlive: () => false });
    const previousStaging = new StagingManager(previous);
    const pending = previousStaging.create(input("pg_pending_write"));
    const inFlight = previousStaging.create(input("pg_in_flight_write"));
    previousStaging.transition(inFlight.id, "IN_FLIGHT", { error: "Private upstream detail user@example.test must not reach disk." });

    current = new TransactionJournal({ path: databasePath, isProcessAlive: (pid) => pid === process.pid });
    const currentStaging = new StagingManager(current);
    const history = current.history();
    const pendingRecord = history.entries.find((entry) => entry.id === pending.id);
    const inFlightRecord = history.entries.find((entry) => entry.id === inFlight.id);

    assert.equal(pendingRecord?.status, "EXPIRED_UNAPPROVED");
    assert.equal(pendingRecord?.snapshotAvailable, false);
    assert.equal(pendingRecord?.auditOnly, true);
    assert.equal(inFlightRecord?.status, "OUTCOME_UNKNOWN");
    assert.equal(inFlightRecord?.errorCategory, "DISPATCH_INTERRUPTED");
    assert.equal(inFlightRecord?.diffSummary, "1 row affected");
    assert.equal(inFlightRecord?.sessionState, "ENDED");
    assert.equal(currentStaging.list().length, 0, "historical audit records must not be hydrated as live transactions");
    assert.throws(() => currentStaging.get(pending.id), /was not found/, "expired records must not have an approval-capable staging payload");
    assert.equal("arguments" in (pendingRecord ?? {}), false);
    assert.equal("before" in (pendingRecord ?? {}), false);
    assert.equal("snapshotPlan" in (pendingRecord ?? {}), false);
    assert.equal("error" in (inFlightRecord ?? {}), false);

    current.close();
    current = undefined;
    previous.close();
    previous = undefined;

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = (db.prepare("PRAGMA table_info(audit_entries)").all() as Array<{ name: string }>).map((column) => column.name);
      assert.deepEqual(columns.sort(), [
        "id", "session_id", "server", "tool", "status", "diff_summary", "affected_rows",
        "error_category", "created_at", "updated_at",
      ].sort());
      const persisted = { ...(db.prepare("SELECT status, error_category FROM audit_entries WHERE id = ?").get(inFlight.id) as { status: string; error_category: string }) };
      assert.deepEqual(persisted, { status: "OUTCOME_UNKNOWN", error_category: "DISPATCH_INTERRUPTED" });
      const journalMode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(journalMode.journal_mode.toLowerCase(), "wal");
    } finally {
      db.close();
    }
  } finally {
    current?.close();
    previous?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second live HyperMCP process does not expire another live session", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".hypermcp-journal-"));
  const databasePath = path.join(directory, "audit.sqlite");
  let first: TransactionJournal | undefined;
  let second: TransactionJournal | undefined;
  try {
    first = new TransactionJournal({ path: databasePath, isProcessAlive: () => true });
    const staging = new StagingManager(first);
    const pending = staging.create(input("pg_pending_write"));
    const inFlight = staging.create(input("pg_in_flight_write"));
    staging.transition(inFlight.id, "IN_FLIGHT");

    second = new TransactionJournal({ path: databasePath, isProcessAlive: () => true });
    const history = second.history();
    assert.equal(history.entries.find((entry) => entry.id === pending.id)?.status, "PENDING");
    assert.equal(history.entries.find((entry) => entry.id === inFlight.id)?.status, "IN_FLIGHT");
    assert.equal(history.entries.find((entry) => entry.id === inFlight.id)?.sessionState, "ACTIVE");
  } finally {
    second?.close();
    first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
