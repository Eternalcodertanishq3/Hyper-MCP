import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const databasePath = process.env.HYPERMCP_TEST_SQLITE_DB;
if (!databasePath) throw new Error("HYPERMCP_TEST_SQLITE_DB is required");
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT COLLATE NOCASE NOT NULL); INSERT OR IGNORE INTO users (id, name, email, role) VALUES (1, 'Ada', 'ada@example.test', 'member'), (2, 'Lin', 'lin@example.test', 'member'); CREATE TABLE IF NOT EXISTS contacts (email TEXT, name TEXT); CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_uq ON contacts(email); INSERT OR IGNORE INTO contacts (email, name) VALUES ('grace@example.test', 'Grace');");
let raceOnce = process.env.HYPERMCP_TEST_OCC_RACE === "1";

const server = new McpServer({ name: "hypermcp-sqlite-occ-fixture", version: "1.0.0" });
server.registerTool("read_query", {
  description: "Read rows from the fixture SQLite database.",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
}, async ({ query }) => {
  if (!/^\s*SELECT\b/i.test(query)) throw new Error("read_query accepts SELECT only");
  const rows = db.prepare(query).all() as Record<string, unknown>[];
  return { content: [{ type: "text", text: JSON.stringify({ rows }) }], structuredContent: { rows } };
});
server.registerTool("write_query", {
  description: "Execute one generated SQLite mutation.",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ affected_rows: z.number().int().nonnegative() }),
}, async ({ query }) => {
  if (raceOnce && /^\s*UPDATE\b/i.test(query)) {
    raceOnce = false;
    db.prepare("UPDATE users SET role = 'MEMBER' WHERE id = 1").run();
  }
  const result = db.prepare(query).run();
  const affected_rows = Number(result.changes);
  return { content: [{ type: "text", text: JSON.stringify({ affected_rows }) }], structuredContent: { affected_rows } };
});

const transport = new StdioServerTransport();
await server.connect(transport);
