# HyperMCP

HyperMCP is a local MCP gateway for **controlled data movement and human-reviewed writes**. Its intended user is a developer running several MCP servers who wants a compact tool surface, local SQL over large tool results, explicit per-tool permissions, and a real approval step before configured mutations run.

HyperMCP exposes five tools to the connected model:

- `hypermcp_search_tools` finds tools that the local policy allows.
- `hypermcp_call_tool` invokes a read-only tool or stages a configured write.
- `hypermcp_query_ref` runs a bounded read-only SQL subset over in-memory `$ref:` tables.
- `hypermcp_pipe_data` stages rows for an explicitly configured destination tool. It never returns those rows as the tool result.
- `hypermcp_tx_manage` lists transactions. Humans can approve, reject, and restore them in the local dashboard or with `hypermcp review` in a terminal.

Unlisted tools fail closed. A tool name or MCP annotation is not treated as proof that a tool is safe. Each upstream must explicitly identify its read-only tools and provide a matching snapshot and restore plan for every staged write, or opt into the narrowly scoped SQLite OCC adapter described below.

## Install and configure

Use Node.js 22.5 or newer. Node's built-in SQLite module is still experimental in the tested Node 22.12 runtime, so Node may print an experimental warning.

```sh
npm ci
npm run build
node bin/hypermcp.js init
```

Edit `hypermcp.config.json`: set each real server command or HTTPS URL, then replace the sample tool names with the names returned by that server. Start HyperMCP with:

```sh
npm start -- --config ./hypermcp.config.json
```

The process speaks MCP over stdio. Its control dashboard binds to `127.0.0.1:4317` by default; set `dashboardPort` to another local port if needed. `hypermcp wrap --config ./hypermcp.config.json` prints a client configuration that launches this built package with the selected config.

After configuring at least one upstream, add HyperMCP to a desktop client:

```sh
node bin/hypermcp.js install claude
node bin/hypermcp.js install cursor
node bin/hypermcp.js install windsurf
node bin/hypermcp.js doctor
```

When installed as a package, use the `hypermcp` command instead of `node bin/hypermcp.js`. The installer targets user-level client configuration. On Windows, Claude Desktop's packaged install may redirect its config into the MSIX package directory, so HyperMCP detects a unique packaged config when present; if multiple installs make the target ambiguous, use `--client-config <path>`. Cursor can also be installed for the current project with `hypermcp install cursor --project`, which writes `.cursor/mcp.json` under the current directory. Use `--client-config <path>` for any custom location. Existing settings and unrelated MCP servers are retained; changed files get a timestamped `.bak` backup. The installer refuses malformed JSON, symbolic-link config files, or a different existing `hypermcp` entry unless `--replace` is supplied. It retains indentation and line-ending style, but JSON comments are not supported.

`hypermcp doctor` checks the Node version, HyperMCP config and upstream working directories, opens the configured upstream connections, and verifies HyperMCP's tool-list handshake. It uses a temporary copy of the schema lock, so it does not create or modify the configured lock file. Upstream processes are started during the check, but no tools are called.

With HyperMCP already running, use `hypermcp review` in an interactive terminal to list pending writes and transactions whose snapshots are available for restore. Select a transaction, then use `y` to approve, `n` to reject, `d` to inspect field changes, or `u` to restore a committed transaction. Use `r` to refresh the list and `q` to quit. Approval still rechecks upstream state; if the staged snapshot is stale, HyperMCP refuses the approval and you must review the updated transaction again. The review command connects only to the loopback dashboard and defaults to port `4317`; use `hypermcp review --config <path>` for a non-default configured port, or `--port <number>` to override it. If the gateway was started with `dashboardPort: 0`, use the actual port printed by the running process with `--port`.

For an HTTP upstream, set `transport` to `streamable-http` or `sse` and provide `url` plus optional `headers`. Remote URLs must use HTTPS. HTTP is accepted only for loopback URLs.

## Tool permissions and reversible writes

`readOnlyTools` is an explicit allowlist. A tool not listed as read-only, staged, or internal cannot be called through HyperMCP.

Add write tools under `stagedTools`. Each entry needs a snapshot tool and a restore tool that cover the **same affected state**. The restore tool must also appear in `internalTools`; models cannot call it directly. HyperMCP records a before snapshot, displays a limited preview in the dashboard, and waits for a human to approve or reject. Approval rechecks the snapshot; if state changed, HyperMCP refreshes the diff and asks for approval again. Restore refuses to overwrite state that changed after the commit.

Do not configure a generic snapshot hook for unrelated writes. If a server cannot provide a complete, reliable restore procedure, leave the write unconfigured: HyperMCP blocks it. Snapshots are compensating restores for the state declared in the plan; they cannot undo side effects outside that state, such as a sent email or a payment already processed.

### SQLite OCC pilot

For a SQLite MCP server that follows HyperMCP's structured query contract, a server may opt into a constrained record-write adapter instead of a custom `stagedTools` plan:

```json
{
  "name": "sqlite",
  "command": "node",
  "args": ["./sqlite-mcp-server.js"],
  "readOnlyTools": ["read_query"],
  "sqliteOcc": {
    "readTool": "read_query",
    "writeTool": "write_query",
    "readArgumentKey": "query",
    "writeArgumentKey": "query",
    "tables": [
      { "name": "users", "primaryKey": "id", "allowedColumns": ["name", "role"] }
    ]
  }
}
```

The configured read tool must accept generated `SELECT` statements (including table-valued SQLite PRAGMA functions) and return MCP `structuredContent` shaped as `{ "rows": [...] }`. The write tool must accept one SQL string and return `{ "affected_rows": <non-negative integer> }` as `structuredContent`. The write tool is intercepted by HyperMCP: model-supplied SQL is parsed and regenerated, and is never forwarded as-is. Startup checks that each configured table is a regular `main` database table and that its configured key is backed by a single-column primary key or unconditional unique index.

This pilot accepts only literal, single-key `UPDATE table SET column = literal [, ...] WHERE key = literal` and `DELETE FROM table WHERE key = literal` statements. The table and update columns must be allowlisted. It rejects expressions, multi-row predicates, comments, semicolons, REAL/BLOB values, generated columns, and rows containing values outside safe INTEGER/TEXT/NULL JSON representations. Before the write, HyperMCP compares the full row using SQLite storage-class checks and binary text comparison in the write predicate. If another writer changes the row after review, the guarded write affects zero rows; HyperMCP refreshes the diff and requires another human approval. SQLite triggers, cascades, and external effects still make this **best-effort record compensation**, not an ACID rollback or a reversal of downstream side effects.

This is a protocol contract, not a claim of compatibility with every SQLite MCP server. The repository's fixture verifies the contract; a real upstream must return the same structured results and support the required read queries. Cross-restart snapshots retain exact SQLite row values when retention is enabled, because redacting values would invalidate conflict checks and restore. Those payloads are not encrypted at rest; keep retention disabled unless storing those row values locally is acceptable.

Secret tokens are only rehydrated for tools named in `secretHydrationTools`, and those tools must also be staged. Normal model-directed calls cannot send a vaulted secret token to an arbitrary tool. Secret detection uses common credential patterns and email masking; it is not complete DLP and should not be treated as a guarantee that all sensitive data will be detected.

Stdio servers inherit only basic runtime variables such as `PATH` and `TEMP`; application credentials are not inherited wholesale. Reference only the needed parent-process variable in config, for example `"API_TOKEN": "${env:MY_SERVICE_TOKEN}"`. The same `${env:NAME}` form works in explicit HTTP headers.

## Run the mock demo

The repository includes two local mock MCP servers for testing. They are **demo fixtures**, not real payment or database integrations:

```sh
npm run demo
```

Open the dashboard URL printed by the command. The demo stages the audit insert and inactive-user deletion separately. Approve the audit insert, approve the deletion, then restore the deletion from its snapshot. The mock data is local and disposable.

## MCP-Lock and local data

On first startup, HyperMCP pins the discovered tool names, descriptions, and input schemas to `mcp-lock.json`. Changed or newly added tools are blocked until an operator reviews the lock file. Keep that file with the config. A lock file is a local integrity baseline; it is not signed and does not protect against an attacker who can edit both the program and its lock file.

Large structured results are stored in in-memory SQLite and represented by `$ref:` pointers. SQL is limited to a single SELECT, active reference tables, 10,000 result rows, 16 MiB of result data, and bounded joins. Reference data and the secret vault disappear when HyperMCP exits.

Transaction metadata is written to a local SQLite WAL journal. By default it is stored at `%LOCALAPPDATA%\hypermcp\audit.sqlite` on Windows and `~/.hypermcp/audit.sqlite` on macOS/Linux. Set `HYPERMCP_DATA_DIR` to choose another directory. The journal stores transaction IDs, tool/server names, status, timestamps, affected-row counts, short summaries, and fixed error categories. It does **not** store tool arguments, snapshots, raw upstream errors, or `$ref:` data. It is a durable local history, not a tamper-proof ledger.

Snapshot payload retention is opt-in. The default `snapshotRetentionHours: 0` keeps payloads in memory only. To retain them for up to 24 hours with a 50 MiB logical payload quota, set:

```json
"policies": {
  "snapshotRetentionHours": 24,
  "maxSnapshotStorageMb": 50
}
```

The payload database is separate from the audit journal at `snapshots/snapshots.sqlite` under the same data directory. It stores before/after JSON only for approved writes: existing snapshot plans store scrubbed values, while SQLite OCC stores the exact row values needed for OCC and restore. POSIX directories/files use `0700`/`0600`; by default on Windows they inherit the user profile's ACL (a custom `HYPERMCP_DATA_DIR` inherits that directory's ACL). Snapshot payloads are **not encrypted at rest**, so only enable retention if that local storage exposure is acceptable. Secret-token mappings are never persisted: a retained diff containing `$secret:` placeholders is viewable after restart but cannot be restored. Credential and PII detection is heuristic, so scrubbed does not mean all personal or sensitive data was removed.

Each retained before or after payload is capped at 5 MiB, with at most 10 MiB reserved per approved transaction before dispatch. The quota check and reservation are transactional across HyperMCP processes. If the pre-state cannot be saved or quota cannot be reserved, HyperMCP does not dispatch the write. If the upstream write succeeds but the after-state cannot be captured or retained, the audit record remains but the cross-restart restore is unavailable. Expired payloads become unavailable and are removed from active records; SQLite secure-delete and WAL checkpointing are requested, but this is not a forensic secure-wipe guarantee for storage media, filesystem snapshots, or copies.

Before dispatch, HyperMCP durably records `IN_FLIGHT` for approved writes and restores. On restart, unfinished operations become `OUTCOME_UNKNOWN`; an incomplete write snapshot reservation is discarded, and no restore is offered unless a verified after-state had already been saved. For an available restore, HyperMCP checks the current upstream state against the saved after-state immediately before calling the configured restore tool, and refuses with `ROLLBACK_CONFLICT` if it changed. Restores are compensating actions for the declared state and cannot reverse downstream side effects. A hash of the snapshot/restore plan must still match the current config. The dashboard shows up to the latest 500 prior-session records; older audit records remain in SQLite. Concurrent live HyperMCP sessions are identified by process ID and are not treated as abandoned.

## Verify and package

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

The tests exercise real stdio MCP child processes, search, secret masking and authorized rehydration, SQL query limits, multi-batch staging, stale-state reapproval, generic rollback, SQLite OCC race rejection and restore, retained snapshots across restart, lock changes, and dashboard request protections. The automated test process cannot connect to loopback in some managed environments; dashboard routes are tested directly, and the mock demo can be checked in a normal local browser.

## Scope and release status

HyperMCP is a **local, single-user preview**, not a multi-user enterprise gateway. The dashboard assumes the local machine and its processes are trusted. References and secret mappings are process-local; there is no OS-backed secret store, multi-user identity, or remote dashboard authentication. The local audit journal and optional snapshot database can be edited by a user with access to the machine. The built-in sqlite module is experimental in Node 22.12. Dependency audit could not reach the configured npm registry in the current restricted environment. Review these items before using HyperMCP with production credentials or publishing a hosted service.
