import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

interface UserRow {
  id: number;
  name: string;
  email: string;
  inactive_days: number;
  role: string;
}

interface MockState {
  users: UserRow[];
  failed_payment_audit: Record<string, unknown>[];
}

const statePath = path.resolve(process.env.HYPERMCP_MOCK_PG_STATE ?? ".hypermcp-mock-pg.json");
const seedUsers: UserRow[] = Array.from({ length: 50 }, (_, index) => ({
  id: index + 1,
  name: "User " + (index + 1),
  email: "user" + String(index + 1).padStart(3, "0") + "@example.test",
  inactive_days: index < 12 ? 100 + index : (index * 7) % 90,
  role: index % 10 === 0 ? "admin" : "member",
}));

async function loadState(): Promise<MockState> {
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8")) as Partial<MockState>;
    return { users: saved.users ?? seedUsers, failed_payment_audit: saved.failed_payment_audit ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { users: seedUsers, failed_payment_audit: [] };
  }
}

let state = await loadState();

async function persist(): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function content(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const server = new McpServer({ name: "mock-postgres", version: "1.0.0" });

server.registerTool("pg_query", {
  description: "Read all rows from users or failed_payment_audit.",
  inputSchema: z.object({ table: z.enum(["users", "failed_payment_audit"]) }),
}, async ({ table }) => content({ table, rows: state[table] }));

server.registerTool("pg_insert_audit_logs", {
  description: "Insert failed payment records into the audit table.",
  inputSchema: z.object({ records: z.array(z.record(z.string(), z.unknown())) }),
}, async ({ records }) => {
  state.failed_payment_audit.push(...records);
  await persist();
  return content({ inserted: records.length, total: state.failed_payment_audit.length });
});

server.registerTool("pg_delete_inactive_users", {
  description: "Delete users whose inactive_days is greater than 90.",
  inputSchema: z.object({}),
}, async () => {
  const deleted = state.users.filter((user) => user.inactive_days > 90);
  state.users = state.users.filter((user) => user.inactive_days <= 90);
  await persist();
  return content({ deleted_count: deleted.length, deleted_ids: deleted.map((user) => user.id) });
});

server.registerTool("pg_restore_users_snapshot", {
  description: "Restore the users table from a previously captured snapshot.",
  inputSchema: z.object({ users: z.unknown() }),
}, async ({ users }) => {
  const rows = Array.isArray(users) ? users : (users && typeof users === "object" && Array.isArray((users as { rows?: unknown }).rows) ? (users as { rows: UserRow[] }).rows : undefined);
  if (!rows) throw new Error("The users snapshot must be an array or an object with a rows array.");
  state.users = rows as UserRow[];
  await persist();
  return content({ restored_count: state.users.length });
});

server.registerTool("pg_restore_audit_snapshot", {
  description: "Restore the failed payment audit table from a previously captured snapshot.",
  inputSchema: z.object({ records: z.unknown() }),
}, async ({ records }) => {
  const rows = Array.isArray(records) ? records : (records && typeof records === "object" && Array.isArray((records as { rows?: unknown }).rows) ? (records as { rows: Record<string, unknown>[] }).rows : undefined);
  if (!rows) throw new Error("The audit snapshot must be an array or an object with a rows array.");
  state.failed_payment_audit = rows as Record<string, unknown>[];
  await persist();
  return content({ restored_count: state.failed_payment_audit.length });
});

const transport = new StdioServerTransport();
await server.connect(transport);
