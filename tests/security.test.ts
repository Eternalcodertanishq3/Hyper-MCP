import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SchemaLock } from "../src/lock/schemaLock.ts";
import { SecretVault } from "../src/lock/secretVault.ts";
import { SqlEngine } from "../src/pipe/sqlEngine.ts";
import { buildUpstreamEnvironment, resolveEnvironmentReferences } from "../src/config/environment.ts";

test("MCP-Lock blocks schema changes and tools added after the trusted baseline", async () => {
  const scratch = await mkdtemp(path.join(process.cwd(), ".hypermcp-security-"));
  const lockPath = path.join(scratch, "mcp-lock.json");
  try {
    const baseline = new SchemaLock(lockPath);
    await baseline.initialize();
    const original = { name: "read_records", description: "Read records", inputSchema: { type: "object" } };
    const initialRecords = await baseline.inspect("store", [original]);
    assert.equal(initialRecords.get(original.name)?.blocked, false);
    await baseline.finishFirstBoot();

    const nextRun = new SchemaLock(lockPath);
    await nextRun.initialize();
    const observed = await nextRun.inspect("store", [
      original,
      { name: "new_tool", description: "A newly advertised tool", inputSchema: { type: "object" } },
      { ...original, description: "Read the latest records" },
    ]);
    assert.equal(observed.get("new_tool")?.blocked, true);
    assert.match(observed.get("new_tool")?.reason ?? "", /not present in the pinned schema lock/);
    assert.equal(observed.get("read_records")?.blocked, true);
    assert.match(observed.get("read_records")?.reason ?? "", /changed since it was pinned/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("secret vault masks credential-shaped object keys and restores tokens locally", () => {
  const vault = new SecretVault(true);
  const secret = ["sk", "live", "99887766554433221100aabbccddeeff"].join("_");
  const email = "person@example.com";
  const masked = vault.scrub({ [secret]: email });
  assert.equal(JSON.stringify(masked).includes(secret), false);
  assert.equal(JSON.stringify(masked).includes(email), false);
  assert.deepEqual(vault.hydrate(masked), { [secret]: email });
});

test("stdio upstreams inherit only runtime environment keys and explicit secrets", () => {
  const env = buildUpstreamEnvironment({ API_TOKEN: "configured-secret" }, {
    PATH: "C:\\runtime", SystemRoot: "C:\\Windows", CLOUD_SECRET: "must-not-inherit",
  });
  assert.deepEqual(env, { PATH: "C:\\runtime", SystemRoot: "C:\\Windows", API_TOKEN: "configured-secret" });
  assert.equal(resolveEnvironmentReferences("Bearer ${env:API_TOKEN}", "server.headers.authorization", { API_TOKEN: "test-token" }), "Bearer test-token");
  assert.throws(() => resolveEnvironmentReferences("${env:MISSING}", "server.env.API_TOKEN", {}), /unset environment variable/);
});

test("reference SQL is read-only, bounded, and constrained to active $ref tables", () => {
  const sql = new SqlEngine();
  try {
    const ref = sql.createReference([{ id: "a", amount: 7 }, { id: "b", amount: 12 }], 80, 20);
    assert.deepEqual(sql.query(`SELECT id, amount FROM ${ref.pointer} ORDER BY amount`), [
      { id: "a", amount: 7 }, { id: "b", amount: 12 },
    ]);
    assert.throws(() => sql.query(`SELECT * FROM ${ref.pointer}; DROP TABLE ${ref.table}`), /Multiple SQL statements/);
    assert.throws(() => sql.query(`SELECT * FROM ${ref.pointer} UNION SELECT * FROM ${ref.pointer}`), /supported analytical query subset/);
    assert.throws(() => sql.query("SELECT * FROM sqlite_master"), /only HyperMCP \$ref tables/);
    assert.throws(() => sql.query("WITH RECURSIVE loop(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM loop) SELECT * FROM loop"), /single read-only SELECT/);
    assert.throws(() => sql.query("SELECT randomblob(100000000)"), /supported analytical query subset/);
  } finally {
    sql.close();
  }
});
