import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { defaultConfig } from "../src/config/defaults.ts";
import type { HyperMCPConfig } from "../src/config/types.ts";
import { HyperMCPRuntime } from "../src/core/runtime.ts";

const execFileAsync = promisify(execFile);

function parseResult(result: { isError?: boolean; content: Array<{ type: string; text?: string }> }): any {
  if (result.isError) throw new Error(result.content.map((block) => block.text ?? "").join("\n"));
  const text = result.content.find((block) => block.type === "text")?.text;
  if (!text) return null;
  return JSON.parse(text);
}

function extractRows(value: unknown): unknown[] {
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object")) return value;
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(extractRows).sort((a, b) => b.length - a.length)[0] ?? [];
  }
  return [];
}

function rowCount(value: any): number {
  if (typeof value?.row_count === "number") return value.row_count;
  return extractRows(value).length;
}

async function connectClient(runtime: HyperMCPRuntime): Promise<{ client: Client; server: ReturnType<HyperMCPRuntime["createMcpServer"]> }> {
  const server = runtime.createMcpServer();
  const client = new Client({ name: "hypermcp-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("HyperMCP routes real stdio MCP servers through all three pillars", { timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(path.join(process.cwd(), ".hypermcp-e2e-"));
  let runtime: HyperMCPRuntime | undefined;
  let client: Client | undefined;
  let mcpServer: ReturnType<HyperMCPRuntime["createMcpServer"]> | undefined;
  try {
    const config = defaultConfig();
    config.dashboardPort = 0;
    config.lockFile = path.join(scratch, "mcp-lock.json");
    const pgState = path.join(scratch, "postgres.json");
    config.servers = config.servers.map((server) => server.name === "postgres" ? { ...server, env: { HYPERMCP_MOCK_PG_STATE: pgState } } : server);
    runtime = new HyperMCPRuntime(config, { journalPath: path.join(scratch, "audit.sqlite") });
    await runtime.start();
    ({ client, server: mcpServer } = await connectClient(runtime));

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 5);
    const metaToolTokens = Math.ceil(JSON.stringify(listed.tools).length / 4);
    assert.ok(metaToolTokens <= 600, "The five meta-tool schemas should stay under the compact context budget.");
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "hypermcp_call_tool", "hypermcp_pipe_data", "hypermcp_query_ref", "hypermcp_search_tools", "hypermcp_tx_manage",
    ]);

    const search = parseResult(await client.callTool({ name: "hypermcp_search_tools", arguments: { query: "list Stripe payment transactions", limit: 5 } }));
    assert.equal(search[0].name, "stripe_list_transactions");
    const pgSearch = parseResult(await client.callTool({ name: "hypermcp_search_tools", arguments: { query: "postgres insert audit failed payment", limit: 5 } }));
    assert.ok(pgSearch.some((tool: any) => tool.name === "pg_insert_audit_logs"));

    const blockedWrite = await client.callTool({ name: "hypermcp_call_tool", arguments: { server: "stripe", tool: "stripe_create_refund", arguments: { charge_id: "ch_1" } } });
    assert.equal(blockedWrite.isError, true, "Unconfigured write tools must fail closed.");
    assert.match(blockedWrite.content.map((block) => block.type === "text" ? block.text : "").join(" "), /TOOL_POLICY_MISSING/);

    const startedAt = performance.now();
    const receipt = parseResult(await client.callTool({
      name: "hypermcp_call_tool",
      arguments: { server: "stripe", tool: "stripe_list_transactions", arguments: {} },
    }));
    const listLatencyMs = performance.now() - startedAt;
    assert.equal(receipt.virtualized, true);
    assert.equal(receipt.row_count, 1500);
    assert.ok(receipt.original_tokens > 45_000);
    assert.ok(receipt.tokens_saved_pct.startsWith("99."));
    assert.ok(!JSON.stringify(receipt).includes(["sk", "live", "99887766554433221100aabbccddeeff"].join("_")));
    assert.ok(!JSON.stringify(receipt).includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert.ok(!JSON.stringify(receipt).includes("@example.test"));
    assert.ok(JSON.stringify(receipt).includes("$secret:v_"));

    const secretExfil = await client.callTool({ name: "hypermcp_call_tool", arguments: { server: "stripe", tool: "stripe_get_transaction", arguments: { id: "$secret:v_001" } } });
    assert.equal(secretExfil.isError, true, "Vaulted secrets must not hydrate into arbitrary tools.");
    assert.match(secretExfil.content.map((block) => block.type === "text" ? block.text : "").join(" "), /SECRET_DESTINATION_BLOCKED/);

    const counts = parseResult(await client.callTool({
      name: "hypermcp_query_ref",
      arguments: { sql: "SELECT status, COUNT(*) as cnt FROM " + receipt.pointer + " GROUP BY status ORDER BY status" },
    }));
    assert.deepEqual(Object.fromEntries(counts.map((row: any) => [row.status, row.cnt])), { failed: 600, pending: 300, succeeded: 600 });

    const pipeResult = parseResult(await client.callTool({
      name: "hypermcp_pipe_data",
      arguments: {
        source_sql: "SELECT id, customer_email, amount, api_key_used FROM " + receipt.pointer + " WHERE status = 'failed' LIMIT 25",
        target_server: "postgres", target_tool: "pg_insert_audit_logs", target_arg_key: "records", batch_size: 10,
      },
    }));
    assert.equal(pipeResult.rows_selected, 25);
    assert.equal(pipeResult.rows_transferred, 0);
    assert.equal(pipeResult.rows_staged, 25);
    assert.equal(pipeResult.tokens_transferred_to_model, 0);
    assert.equal(pipeResult.staged_transactions.length, 3);
    for (const txId of pipeResult.staged_transactions) {
      try {
        assert.equal((await runtime.manageTransaction(txId, "approve") as any).status, "COMMITTED");
      } catch (error) {
        assert.match(String(error), /STALE_SNAPSHOT/);
        assert.equal((await runtime.manageTransaction(txId, "approve") as any).status, "COMMITTED", "A refreshed, reviewed batch should commit on explicit re-approval.");
      }
    }
    const persisted = JSON.parse(await readFile(pgState, "utf8"));
    assert.equal(persisted.failed_payment_audit.length, 25);
    assert.equal(persisted.failed_payment_audit[0].api_key_used, ["sk", "live", "99887766554433221100aabbccddeeff"].join("_"));
    assert.match(persisted.failed_payment_audit[0].customer_email, /^customer\d+@example\.test$/);

    const pending = parseResult(await client.callTool({
      name: "hypermcp_call_tool",
      arguments: { server: "postgres", tool: "pg_delete_inactive_users", arguments: {}, bypassStaging: true },
    }));
    assert.equal(pending.status, "STAGED_FOR_APPROVAL");
    assert.equal(pending.diff_summary, "12 rows affected by pg_delete_inactive_users");
    const listedTransactions = parseResult(await client.callTool({ name: "hypermcp_tx_manage", arguments: { action: "list" } }));
    assert.equal(listedTransactions[0].status, "PENDING");
    assert.equal(listedTransactions[0].arguments, undefined, "Transaction listings must not return stored payloads or snapshots to the model.");
    assert.equal(listedTransactions[0].before, undefined);
    const failClosedStage = parseResult(await client.callTool({
      name: "hypermcp_call_tool",
      arguments: { server: "postgres", tool: "pg_delete_inactive_users", arguments: {} },
    }));
    const journal = (runtime.staging as any).journal;
    const originalRecord = journal.record.bind(journal);
    journal.record = (entry: any) => {
      if (entry.status === "IN_FLIGHT") throw new Error("simulated durable journal write failure");
      return originalRecord(entry);
    };
    try {
      await assert.rejects(runtime.manageTransaction(failClosedStage.tx_id, "approve"), /simulated durable journal write failure/);
    } finally {
      journal.record = originalRecord;
    }
    assert.equal(runtime.staging.get(failClosedStage.tx_id).status, "PENDING");
    assert.equal(JSON.parse(await readFile(pgState, "utf8")).users.length, 50, "upstream writes must not dispatch unless IN_FLIGHT was durably recorded");
    await runtime.manageTransaction(failClosedStage.tx_id, "reject");
    let users = parseResult(await client.callTool({
      name: "hypermcp_call_tool",
      arguments: { server: "postgres", tool: "pg_query", arguments: { table: "users" } },
    }));
    assert.equal(rowCount(users), 50);

    const unauthorizedApproval = await client.callTool({ name: "hypermcp_tx_manage", arguments: { action: "approve", tx_id: pending.tx_id } });
    assert.equal(unauthorizedApproval.isError, true, "The model-facing transaction tool must not approve its own staged writes.");
    const approved = await runtime.manageTransaction(pending.tx_id, "approve");
    assert.equal((approved as any).status, "COMMITTED");
    users = parseResult(await client.callTool({
      name: "hypermcp_call_tool",
      arguments: { server: "postgres", tool: "pg_query", arguments: { table: "users" } },
    }));
    assert.equal(rowCount(users), 38);

    const undone = await runtime.manageTransaction(pending.tx_id, "undo");
    assert.equal((undone as any).status, "ROLLED_BACK");
    users = parseResult(await client.callTool({
      name: "hypermcp_call_tool",
      arguments: { server: "postgres", tool: "pg_query", arguments: { table: "users" } },
    }));
    assert.equal(rowCount(users), 50);

    const dashboardState = runtime.getDashboardState() as any;
    assert.equal(dashboardState.metrics.active_reference_tables, 4);
    assert.ok(dashboardState.metrics.secrets_vaulted > 0);
    const restoredTransaction = dashboardState.transactions.find((transaction: any) => transaction.id === pending.tx_id);
    assert.equal(restoredTransaction.status, "ROLLED_BACK");
    assert.equal(restoredTransaction.affectedRows, 12);
    assert.equal(restoredTransaction.after.total_rows, 50);

    await client.close();
    client = undefined;
    await mcpServer.close();
    mcpServer = undefined;
    await runtime.close();
    runtime = undefined;

    const compromisedConfig: HyperMCPConfig = {
      ...config,
      servers: config.servers.map((server) => server.name === "stripe" ? { ...server, env: { ...server.env, SIMULATE_RUG_PULL: "1" } } : server),
    };
    runtime = new HyperMCPRuntime(compromisedConfig, { journalPath: path.join(scratch, "audit.sqlite") });
    await runtime.start({ dashboard: false });
    const priorSessionState = runtime.getDashboardState() as any;
    const priorAudit = priorSessionState.auditHistory.entries.find((entry: any) => entry.id === pending.tx_id);
    assert.equal(priorAudit.status, "ROLLED_BACK");
    assert.equal(priorAudit.auditOnly, true);
    assert.equal(priorAudit.snapshotAvailable, false);
    assert.equal(priorAudit.before, undefined);
    assert.equal(runtime.staging.list().length, 0, "prior-session entries must not be loaded into the live approval manager");
    ({ client, server: mcpServer } = await connectClient(runtime));
    const compromisedSearch = parseResult(await client.callTool({ name: "hypermcp_search_tools", arguments: { query: "export logs" } }));
    assert.ok(compromisedSearch.some((tool: any) => tool.lock_status === "BLOCKED_RUG_PULL"));
    const blocked = await client.callTool({ name: "hypermcp_call_tool", arguments: { server: "stripe", tool: "stripe_export_logs", arguments: {} } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content.map((block) => block.type === "text" ? block.text : "").join(" "), /RUG_PULL_DETECTED/);

    await client.close();
    client = undefined;
    await mcpServer.close();
    mcpServer = undefined;
    await runtime.close();
    runtime = undefined;

    const cliConfig: HyperMCPConfig = { ...config, dashboardPort: 0, lockFile: path.join(scratch, "cli-lock.json") };
    const cliConfigPath = path.join(scratch, "hypermcp.config.json");
    await writeFile(cliConfigPath, JSON.stringify(cliConfig), "utf8");
    const clientConfigPath = path.join(scratch, "cursor-mcp.json");
    const installed = await execFileAsync(process.execPath, [
      "--experimental-sqlite", "--import", "tsx", path.resolve("src/index.ts"), "install", "cursor",
      "--config", cliConfigPath, "--client-config", clientConfigPath,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
    assert.match(installed.stdout, /Installed HyperMCP/);
    const clientConfig = JSON.parse(await readFile(clientConfigPath, "utf8"));
    assert.equal(clientConfig.mcpServers.hypermcp.command, process.execPath);
    assert.ok(clientConfig.mcpServers.hypermcp.args.includes(path.resolve("dist/index.js")));
    assert.ok(clientConfig.mcpServers.hypermcp.args.includes(cliConfigPath));

    const doctor = await execFileAsync(process.execPath, [
      path.resolve("bin/hypermcp.js"), "doctor", "--config", cliConfigPath,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    const doctorResult = JSON.parse(doctor.stdout);
    assert.equal(doctorResult.status, "healthy");
    assert.equal(doctorResult.mcp_tool_surface, "tool listing handshake passed");
    await assert.rejects(readFile(cliConfig.lockFile), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "doctor must not create or modify the configured lock file");
    await copyFile(config.lockFile, cliConfig.lockFile);
    const lockBeforeDoctor = await readFile(cliConfig.lockFile);
    const doctorWithExistingLock = await execFileAsync(process.execPath, [
      path.resolve("bin/hypermcp.js"), "doctor", "--config", cliConfigPath,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
    assert.equal(JSON.parse(doctorWithExistingLock.stdout).status, "healthy");
    assert.deepEqual(await readFile(cliConfig.lockFile), lockBeforeDoctor, "doctor must not change an existing schema lock");

    client = new Client({ name: "hypermcp-stdio-check", version: "0.1.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-sqlite", "--import", "tsx", path.resolve("src/index.ts"), "start", "--config", cliConfigPath],
      cwd: process.cwd(),
    }));
    const cliTools = await client.listTools();
    assert.equal(cliTools.tools.length, 5);

    process.stdout.write(JSON.stringify({ metaToolTokens, listLatencyMs: Math.round(listLatencyMs), originalTokens: receipt.original_tokens, virtualizedTokens: receipt.virtualized_tokens, savings: receipt.tokens_saved_pct, rowsStaged: pipeResult.rows_staged, usersRestored: 50, rugPullBlocked: true, stdioEntrypointVerified: true }) + "\n");
  } finally {
    await client?.close().catch(() => undefined);
    await mcpServer?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
});
