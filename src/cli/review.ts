import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

type ReviewAction = "approve" | "reject" | "undo";

interface ReviewTransaction {
  id: string;
  server: string;
  tool: string;
  status: string;
  createdAt?: string;
  diffSummary?: string;
  affectedRows?: number;
  after?: unknown;
  restoreAvailable?: boolean;
  snapshotState?: string;
}

interface ReviewState {
  transactions?: ReviewTransaction[];
  auditHistory?: { entries?: ReviewTransaction[] };
}

interface ReviewSnapshot {
  before?: unknown;
  after?: unknown;
  previewAfter?: unknown;
}

export interface ReviewOptions {
  port: number;
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean };
  noColor?: boolean;
}

export interface ReviewArguments {
  port?: number;
  configPath?: string;
}

export function parseReviewArguments(args: string[]): ReviewArguments {
  let port: number | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      if (port !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--port requires one port number and may be used only once.");
      }
      const value = args[++index];
      if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 1 to 65535.");
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535.");
    } else if (argument === "--config") {
      if (configPath !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error("--config requires one path and may be used only once.");
      }
      configPath = args[++index];
    } else {
      throw new Error("Unknown review option: " + argument + ". Usage: hypermcp review [--config path] [--port number]");
    }
  }
  return { ...(port !== undefined ? { port } : {}), ...(configPath ? { configPath } : {}) };
}

export class ReviewApiClient {
  private readonly baseUrl: string;

  constructor(port: number, private readonly fetcher: typeof fetch = fetch) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Review port must be an integer from 1 to 65535.");
    this.baseUrl = "http://127.0.0.1:" + port;
  }

  async getState(): Promise<ReviewState> {
    const value = await this.request("/api/state");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The local dashboard returned an invalid state document.");
    return value as ReviewState;
  }

  async getSnapshot(id: string): Promise<ReviewSnapshot> {
    const value = await this.request("/api/tx/" + encodeURIComponent(id) + "/snapshot");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The local dashboard returned an invalid snapshot document.");
    return value as ReviewSnapshot;
  }

  async act(id: string, action: ReviewAction): Promise<unknown> {
    return this.request("/api/tx/" + encodeURIComponent(id) + "/" + action, { method: "POST" });
  }

  private async request(path: string, options: { method?: "GET" | "POST" } = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method: options.method ?? "GET",
        headers: options.method === "POST"
          ? { origin: this.baseUrl, "content-type": "application/json" }
          : { accept: "application/json" },
        ...(options.method === "POST" ? { body: "" } : { signal: AbortSignal.timeout(5000) }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("The local HyperMCP dashboard did not respond within 5 seconds.");
      throw new Error("Could not connect to " + this.baseUrl + ". Is HyperMCP running with its dashboard enabled?");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("The local HyperMCP dashboard returned an invalid response (HTTP " + response.status + ").");
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? safeText(payload.error)
        : "HTTP " + response.status;
      throw new Error(message);
    }
    return payload;
  }
}

function safeText(value: unknown): string {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function isUndoable(transaction: ReviewTransaction): boolean {
  if (transaction.status !== "COMMITTED" && transaction.status !== "OUTCOME_UNKNOWN") return false;
  return transaction.restoreAvailable === true || (transaction.restoreAvailable !== false && transaction.after !== undefined);
}

function actionableTransactions(state: ReviewState): ReviewTransaction[] {
  const unique = new Map<string, ReviewTransaction>();
  for (const transaction of state.auditHistory?.entries ?? []) unique.set(transaction.id, transaction);
  for (const transaction of state.transactions ?? []) unique.set(transaction.id, transaction);
  return [...unique.values()]
    .filter((transaction) => transaction && typeof transaction.id === "string" &&
      (transaction.status === "PENDING" || isUndoable(transaction)))
    .sort((left, right) => {
      const leftPending = left.status === "PENDING";
      const rightPending = right.status === "PENDING";
      if (leftPending !== rightPending) return leftPending ? -1 : 1;
      return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
    });
}

function colorize(text: string, code: number, enabled: boolean): string {
  return enabled ? "\u001b[" + code + "m" + text + "\u001b[0m" : text;
}

function formatValue(value: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? String(value);
  } catch {
    encoded = "[unavailable value]";
  }
  return encoded.length > 240 ? encoded.slice(0, 237) + "..." : encoded;
}

interface FieldChange {
  path: string;
  before?: unknown;
  after?: unknown;
  kind: "added" | "removed" | "changed";
}

function collectChanges(before: unknown, after: unknown, path: string, output: FieldChange[], depth = 0): void {
  if (output.length >= 500) return;
  if (Object.is(before, after)) return;
  if (depth >= 64 || !before || !after || typeof before !== "object" || typeof after !== "object") {
    output.push({ path, before, after, kind: "changed" });
    return;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after)) {
      output.push({ path, before, after, kind: "changed" });
      return;
    }
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length && output.length < 500; index += 1) {
      const itemPath = path + "[" + index + "]";
      if (index >= before.length) output.push({ path: itemPath, after: after[index], kind: "added" });
      else if (index >= after.length) output.push({ path: itemPath, before: before[index], kind: "removed" });
      else collectChanges(before[index], after[index], itemPath, output, depth + 1);
    }
    return;
  }

  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (output.length >= 500) break;
    const childPath = path + "[" + JSON.stringify(key) + "]";
    if (!Object.hasOwn(left, key)) output.push({ path: childPath, after: right[key], kind: "added" });
    else if (!Object.hasOwn(right, key)) output.push({ path: childPath, before: left[key], kind: "removed" });
    else collectChanges(left[key], right[key], childPath, output, depth + 1);
  }
}

function printDiff(snapshot: ReviewSnapshot, transaction: ReviewTransaction, write: (line: string) => void, useColor: boolean): void {
  const after = snapshot.previewAfter !== undefined ? snapshot.previewAfter : snapshot.after;
  if (after === undefined) {
    write("A complete before/after diff is unavailable for this transaction.");
    write("Before snapshot:");
    write(formatValue(snapshot.before));
    return;
  }
  const changes: FieldChange[] = [];
  collectChanges(snapshot.before, after, "$", changes);
  write("Diff for " + safeText(transaction.server) + "." + safeText(transaction.tool) + " (" + safeText(transaction.id) + ")");
  if (changes.length === 0) {
    write("No field-level changes are visible in the captured snapshots.");
    return;
  }
  for (const change of changes) {
    if (change.kind !== "added") write(colorize("- " + change.path + ": " + formatValue(change.before), 31, useColor));
    if (change.kind !== "removed") write(colorize("+ " + change.path + ": " + formatValue(change.after), 32, useColor));
  }
  if (changes.length === 500) write("Diff output is capped at 500 field changes.");
}

export async function runReview(options: ReviewOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY !== true || output.isTTY !== true) throw new Error("`hypermcp review` needs an interactive terminal. Use the local dashboard for non-interactive environments.");
  const client = new ReviewApiClient(options.port);
  const useColor = !options.noColor && !process.env.NO_COLOR && Boolean(output.isTTY);
  const write = (line = "") => output.write(line + "\n");
  const rl = createInterface({ input, output, terminal: true });
  rl.on("SIGINT", () => rl.close());

  try {
    let state = await client.getState();
    while (true) {
      const transactions = actionableTransactions(state);
      write();
      write(colorize("HyperMCP Review", 1, useColor) + " · local dashboard http://127.0.0.1:" + options.port);
      if (transactions.length === 0) {
        write("No pending or restorable transactions.");
      } else {
        write("Pending transactions are listed first; committed transactions appear only when restore is available.");
        transactions.forEach((transaction, index) => {
          const status = transaction.status === "PENDING" ? colorize("PENDING", 33, useColor) : colorize(transaction.status, 36, useColor);
          const rows = Number.isFinite(transaction.affectedRows) ? " · " + transaction.affectedRows + " row(s)" : "";
          write("[" + (index + 1) + "] " + status + " " + safeText(transaction.server) + "." + safeText(transaction.tool) + rows);
          if (transaction.diffSummary) write("    " + safeText(transaction.diffSummary));
        });
      }

      let selection: string;
      try {
        selection = (await rl.question("Select number · r refresh · q quit: ")).trim().toLowerCase();
      } catch {
        write("Review closed.");
        return;
      }
      if (selection === "q") return;
      if (selection === "r") {
        state = await client.getState();
        continue;
      }
      const selectedIndex = Number(selection);
      if (!/^\d+$/.test(selection) || selectedIndex < 1 || selectedIndex > transactions.length) {
        write("Choose a listed transaction number, r, or q.");
        continue;
      }

      const transaction = transactions[selectedIndex - 1];
      write();
      write(safeText(transaction.id) + " · " + safeText(transaction.server) + "." + safeText(transaction.tool));
      write("Status: " + safeText(transaction.status));
      if (transaction.diffSummary) write("Summary: " + safeText(transaction.diffSummary));
      if (transaction.status === "PENDING") write("Actions: y approve · n reject · d diff · b back · q quit");
      else write("Actions: u restore · d diff · b back · q quit");

      let action: string;
      try {
        action = (await rl.question("> ")).trim().toLowerCase();
      } catch {
        write("Review closed.");
        return;
      }
      if (action === "q") return;
      if (action === "b") continue;
      if (action === "d") {
        try {
          const snapshot = await client.getSnapshot(transaction.id);
          printDiff(snapshot, transaction, write, useColor);
        } catch (error) {
          write("Diff unavailable: " + safeText(error instanceof Error ? error.message : error));
        }
        continue;
      }
      const allowedAction: ReviewAction | undefined = action === "y" && transaction.status === "PENDING" ? "approve"
        : action === "n" && transaction.status === "PENDING" ? "reject"
          : action === "u" && isUndoable(transaction) ? "undo"
            : undefined;
      if (!allowedAction) {
        write("That action is not available for this transaction.");
        continue;
      }
      try {
        await client.act(transaction.id, allowedAction);
        write(allowedAction === "approve" ? "Approved." : allowedAction === "reject" ? "Rejected." : "Restore completed.");
      } catch (error) {
        write("Action failed: " + safeText(error instanceof Error ? error.message : error));
        if (allowedAction === "approve") write("If the snapshot became stale, inspect the refreshed diff and approve again.");
      }
      state = await client.getState();
    }
  } finally {
    rl.close();
  }
}
