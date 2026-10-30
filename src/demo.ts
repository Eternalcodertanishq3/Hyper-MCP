import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { defaultConfig } from "./config/defaults.ts";
import type { UpstreamServerConfig } from "./config/types.ts";
import { HyperMCPRuntime } from "./core/runtime.ts";

function parse(result: { isError?: boolean; content: Array<{ type: string; text?: string }> }): any {
  if (result.isError) throw new Error(result.content.map((block) => block.text ?? "").join("\n"));
  return JSON.parse(result.content.find((block) => block.type === "text")?.text ?? "null");
}

async function main(): Promise<void> {
  const root = process.cwd();
  const runId = randomUUID().slice(0, 8);
  const config = defaultConfig();
  config.dashboardPort = Number(process.env.HYPERMCP_PORT ?? 4317);
  config.lockFile = path.join(root, ".hypermcp-demo-lock-" + runId + ".json");
  config.servers = config.servers.map((server): UpstreamServerConfig => {
    if (server.name === "stripe") return { ...server, env: { SIMULATE_RUG_PULL: "0" } };
    return { ...server, env: { HYPERMCP_MOCK_PG_STATE: path.join(root, ".hypermcp-demo-postgres-" + runId + ".json") } };
  });

  const journalPath = path.join(root, ".hypermcp-demo-audit-" + runId + ".sqlite");
  const baseline = new HyperMCPRuntime({ ...config, dashboardPort: 0 }, { journalPath });
  await baseline.start({ dashboard: false });
  await baseline.close();

  config.servers = config.servers.map((server): UpstreamServerConfig => server.name === "stripe" ? { ...server, env: { SIMULATE_RUG_PULL: "1" } } : server);
  const runtime = new HyperMCPRuntime(config, { journalPath });
  await runtime.start();
  const mcpServer = runtime.createMcpServer();
  const client = new Client({ name: "hypermcp-live-demo", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const receipt = parse(await client.callTool({ name: "hypermcp_call_tool", arguments: { server: "stripe", tool: "stripe_list_transactions", arguments: {} } }));
    const pipe = parse(await client.callTool({
      name: "hypermcp_pipe_data",
      arguments: {
        source_sql: "SELECT id, customer_email, amount, api_key_used FROM " + receipt.pointer + " WHERE status = 'failed' LIMIT 25",
        target_server: "postgres", target_tool: "pg_insert_audit_logs", target_arg_key: "records", batch_size: 25,
      },
    }));
    const staged = parse(await client.callTool({ name: "hypermcp_call_tool", arguments: { server: "postgres", tool: "pg_delete_inactive_users", arguments: {} } }));
    process.stdout.write(JSON.stringify({ dashboard: runtime.dashboardUrl, pointer: receipt.pointer, rowCount: receipt.row_count, savings: receipt.tokens_saved_pct, secrets: runtime.vault.size, rugPullsBlocked: runtime.schemaLock.getStatus().blockedTools, rowsStaged: pipe.rows_staged, transactions: runtime.staging.list().map((tx) => ({ id: tx.id, tool: tx.tool, status: tx.status })), transaction: staged.tx_id, status: staged.status }) + "\n");
    process.stdout.write("The demo is ready. Approve each staged write in the browser, then restore the inactive-user snapshot. Press Ctrl+C here when done.\n");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    await client.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
