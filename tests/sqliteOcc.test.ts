import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config/defaults.ts";
import { HyperMCPRuntime } from "../src/core/runtime.ts";
import { buildSQLiteOccWriteQuery, parseSQLiteOccMutation, validateSQLiteOccSchema } from "../src/stage/sqliteOcc.ts";

const tablePolicy = [{ name: "users", primaryKey: "id", allowedColumns: ["name", "role"] }];

test("SQLite OCC parser and schema checks fail closed and generate binary, type-aware guards", () => {
  const mutation = parseSQLiteOccMutation("UPDATE users SET name = 'O''Brien', role = 'admin' WHERE id = 7", tablePolicy);
  assert.deepEqual(mutation, {
    operation: "update", table: "users", primaryKey: "id", key: 7,
    assignments: { name: "O'Brien", role: "admin" },
  });
  assert.throws(() => parseSQLiteOccMutation("UPDATE users SET role='x' WHERE id=1 OR 1=1", tablePolicy), /SQLITE_OCC_REJECTED/);
  assert.throws(() => parseSQLiteOccMutation("DELETE FROM users WHERE id=1; DELETE FROM users", tablePolicy), /SQLITE_OCC_REJECTED/);
  assert.throws(() => parseSQLiteOccMutation("UPDATE users SET role=1.5 WHERE id=1", tablePolicy), /SQLITE_OCC_REJECTED/);
  assert.throws(() => parseSQLiteOccMutation("UPDATE users SET id=2 WHERE id=1", tablePolicy), /SQLITE_OCC_REJECTED/);

  const schema = validateSQLiteOccSchema({
    table: "users", primaryKey: "id", allowedColumns: ["role"],
    tableRows: [{ name: "users", type: "table" }],
    columnRows: [
      { name: "id", type: "INTEGER", pk: 1, hidden: 0 },
      { name: "role", type: "TEXT", pk: 0, hidden: 0 },
    ],
    indexRows: [],
  });
  const sql = buildSQLiteOccWriteQuery(mutation, schema, { id: 7, name: "Ada", role: "member" });
  assert.match(sql, /typeof\("role"\) = 'text'/);
  assert.match(sql, /COLLATE BINARY/);
  assert.match(sql, /"name" = 'O''Brien'/);

  assert.throws(() => validateSQLiteOccSchema({
    table: "users", primaryKey: "id", allowedColumns: ["role"],
    tableRows: [{ name: "users", type: "table" }],
    columnRows: [{ name: "id", type: "TEXT", pk: 0, hidden: 0 }, { name: "role", type: "TEXT", pk: 0, hidden: 0 }],
    indexRows: [{ index_name: "idx_partial", is_unique: 1, partial: 1, cid: 0, column_name: "id", is_key: 1 }],
  }), /not backed by a single-column primary key or unconditional unique index/);
});

test("SQLite OCC stages, guards races, commits, and restores only the reviewed row", { timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(path.join(process.cwd(), ".hypermcp-sqlite-occ-"));
  const databasePath = path.join(scratch, "fixture.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT COLLATE NOCASE NOT NULL); INSERT INTO users VALUES (1, 'Ada', 'ada@example.test', 'member'), (2, 'Lin', 'lin@example.test', 'member'); CREATE TABLE contacts (email TEXT, name TEXT); CREATE UNIQUE INDEX contacts_email_uq ON contacts(email); INSERT INTO contacts VALUES ('grace@example.test', 'Grace');");
  db.close();

  const config = defaultConfig();
  config.dashboardPort = 0;
  config.lockFile = path.join(scratch, "mcp-lock.json");
  config.policies.snapshotRetentionHours = 24;
  config.policies.maxSnapshotStorageMb = 50;
  config.servers = [{
    name: "sqlite",
    command: process.execPath,
    args: ["--experimental-sqlite", "--import", "tsx", path.resolve("tests/mockSQLiteOccMcp.ts")],
    cwd: process.cwd(),
    env: { HYPERMCP_TEST_SQLITE_DB: databasePath, HYPERMCP_TEST_OCC_RACE: "1" },
    readOnlyTools: ["read_query"],
    sqliteOcc: { readTool: "read_query", writeTool: "write_query", readArgumentKey: "query", writeArgumentKey: "query", tables: [...tablePolicy, { name: "contacts", primaryKey: "email", allowedColumns: ["name"] }] },
  }];
  const journalPath = path.join(scratch, "audit.sqlite");
  const snapshotPath = path.join(scratch, "snapshots.sqlite");
  let runtime: HyperMCPRuntime | undefined = new HyperMCPRuntime(config, { journalPath, snapshotPath });
  let verify: DatabaseSync | undefined;
  try {
    await runtime.start({ dashboard: false });
    const staged = await runtime.callTool({ server: "sqlite", tool: "write_query", arguments: { query: "UPDATE users SET role = 'admin' WHERE id = 1" } }) as { tx_id: string };
    assert.equal(runtime.staging.get(staged.tx_id).status, "PENDING");
    const snapshotView = JSON.stringify(runtime.getTransactionSnapshot(staged.tx_id));
    assert.ok(!snapshotView.includes("ada@example.test"), "dashboard snapshot responses must scrub row values");
    assert.ok(JSON.stringify(runtime.getDashboardState()).includes("$secret:v_"));
    await assert.rejects(runtime.callTool({ server: "sqlite", tool: "write_query", arguments: { query: "UPDATE users SET role = 'admin' WHERE id = 1 OR 1=1" } }), /SQLITE_OCC_REJECTED/);

    await assert.rejects(runtime.manageTransaction(staged.tx_id, "approve"), /STATE_CONFLICT/);
    assert.equal(runtime.staging.get(staged.tx_id).status, "PENDING", "a valid affected_rows=0 response is a known conflict, not an ambiguous write");
    const committed = await runtime.manageTransaction(staged.tx_id, "approve") as { status: string };
    assert.equal(committed.status, "COMMITTED");

    const inspect = new DatabaseSync(databasePath);
    const committedRow = JSON.parse(JSON.stringify(inspect.prepare("SELECT id, name, role FROM users WHERE id=1").get()));
    assert.deepEqual(committedRow, { id: 1, name: "Ada", role: "admin" });
    inspect.close();

    const undone = await runtime.manageTransaction(staged.tx_id, "undo") as { status: string };
    assert.equal(undone.status, "ROLLED_BACK");
    verify = new DatabaseSync(databasePath);
    assert.deepEqual(JSON.parse(JSON.stringify(verify.prepare("SELECT id, name, role FROM users WHERE id=1").get())), { id: 1, name: "Ada", role: "MEMBER" });

    const deletion = await runtime.callTool({ server: "sqlite", tool: "write_query", arguments: { query: "DELETE FROM users WHERE id = 2" } }) as { tx_id: string };
    assert.equal((await runtime.manageTransaction(deletion.tx_id, "approve") as { status: string }).status, "COMMITTED");
    assert.equal(verify.prepare("SELECT id FROM users WHERE id=2").all().length, 0);
    assert.equal((await runtime.manageTransaction(deletion.tx_id, "undo") as { status: string }).status, "ROLLED_BACK");
    assert.deepEqual(JSON.parse(JSON.stringify(verify.prepare("SELECT id, name, role FROM users WHERE id=2").get())), { id: 2, name: "Lin", role: "member" });

    const uniqueIndexWrite = await runtime.callTool({ server: "sqlite", tool: "write_query", arguments: { query: "UPDATE contacts SET name = 'Grace Hopper' WHERE email = 'grace@example.test'" } }) as { tx_id: string };
    assert.equal((await runtime.manageTransaction(uniqueIndexWrite.tx_id, "approve") as { status: string }).status, "COMMITTED");
    assert.equal((verify.prepare("SELECT name FROM contacts WHERE email='grace@example.test'").get() as { name: string }).name, "Grace Hopper");
    assert.equal((await runtime.manageTransaction(uniqueIndexWrite.tx_id, "undo") as { status: string }).status, "ROLLED_BACK");

    const conflicting = await runtime.callTool({ server: "sqlite", tool: "write_query", arguments: { query: "UPDATE users SET role = 'admin' WHERE id = 1" } }) as { tx_id: string };
    await runtime.manageTransaction(conflicting.tx_id, "approve");
    verify.prepare("UPDATE users SET name = 'Concurrent' WHERE id=1").run();
    await assert.rejects(runtime.manageTransaction(conflicting.tx_id, "undo"), /ROLLBACK_CONFLICT/);
    assert.deepEqual(JSON.parse(JSON.stringify(verify.prepare("SELECT id, name, role FROM users WHERE id=1").get())), { id: 1, name: "Concurrent", role: "admin" });
    verify.close();
    verify = undefined;
    const retained = await runtime.callTool({ server: "sqlite", tool: "write_query", arguments: { query: "UPDATE users SET role = 'manager' WHERE id = 2" } }) as { tx_id: string };
    await runtime.manageTransaction(retained.tx_id, "approve");
    await runtime.close();
    runtime = undefined;

    runtime = new HyperMCPRuntime(config, { journalPath, snapshotPath });
    await runtime.start({ dashboard: false });
    const history = runtime.getDashboardState() as any;
    const retainedAudit = history.auditHistory.entries.find((entry: any) => entry.id === retained.tx_id);
    assert.equal(retainedAudit.snapshotAvailable, true);
    assert.equal(retainedAudit.restoreAvailable, true);
    assert.ok(!JSON.stringify(retainedAudit).includes("ada@example.test"));
    assert.equal((await runtime.manageTransaction(retained.tx_id, "undo") as { status: string }).status, "ROLLED_BACK");
    const finalDb = new DatabaseSync(databasePath);
    assert.equal((finalDb.prepare("SELECT role FROM users WHERE id=2").get() as { role: string }).role, "member");
    finalDb.close();
  } finally {
    verify?.close();
    await runtime?.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
});
