import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HyperMCPConfig } from "./types.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const node = process.execPath;
const sourceMode = import.meta.url.endsWith(".ts");
const mockDirectory = path.join(projectRoot, sourceMode ? "src" : "dist", "mocks");
const mockLoaderArgs = sourceMode ? ["--experimental-sqlite", "--import", "tsx"] : ["--experimental-sqlite"];

export function defaultConfig(): HyperMCPConfig {
  return {
    dashboardPort: Number(process.env.HYPERMCP_PORT ?? 4317),
    lockFile: path.join(projectRoot, "mcp-lock.json"),
    policies: {
      virtualizeThresholdTokens: 500,
      searchLimit: 5,
      maskEmails: true,
      snapshotRetentionHours: 0,
      maxSnapshotStorageMb: 50,
    },
    servers: [
      {
        name: "stripe",
        command: node,
        args: [...mockLoaderArgs, path.join(mockDirectory, sourceMode ? "mockStripeMcp.ts" : "mockStripeMcp.js")],
        cwd: projectRoot,
        readOnlyTools: [
          "stripe_list_transactions", "stripe_get_transaction", "stripe_list_customers", "stripe_get_customer",
          "stripe_list_products", "stripe_get_product", "stripe_search_disputes", "stripe_list_payouts",
          "stripe_export_logs", "stripe_list_balance",
        ],
      },
      {
        name: "postgres",
        command: node,
        args: [...mockLoaderArgs, path.join(mockDirectory, sourceMode ? "mockPostgresMcp.ts" : "mockPostgresMcp.js")],
        cwd: projectRoot,
        readOnlyTools: ["pg_query"],
        internalTools: ["pg_restore_users_snapshot", "pg_restore_audit_snapshot"],
        secretHydrationTools: ["pg_insert_audit_logs"],
        stagedTools: {
          pg_insert_audit_logs: {
            tool: "pg_query", arguments: { table: "failed_payment_audit" },
            restoreTool: "pg_restore_audit_snapshot", restoreArgumentKey: "records",
          },
          pg_delete_inactive_users: {
            tool: "pg_query", arguments: { table: "users" },
            restoreTool: "pg_restore_users_snapshot", restoreArgumentKey: "users",
          },
        },
      },
    ],
  };
}

export function resolveConfigFile(filePath: string): string {
  return path.resolve(filePath);
}
