import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { ReferenceTableInfo } from "../config/types.ts";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlType(values: unknown[]): string {
  const defined = values.filter((value) => value !== null && value !== undefined);
  if (defined.length > 0 && defined.every((value) => typeof value === "number" && Number.isInteger(value))) return "INTEGER";
  if (defined.length > 0 && defined.every((value) => typeof value === "number")) return "REAL";
  return "TEXT";
}

function toCell(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

const MAX_REFERENCES = 100;
const MAX_REFERENCE_ROWS = 100_000;
const MAX_REFERENCE_COLUMNS = 200;
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_QUERY_LENGTH = 8 * 1024;
const MAX_QUERY_ROWS = 10_000;
const MAX_QUERY_BYTES = 16 * 1024 * 1024;
const MAX_JOIN_SCAN_ESTIMATE = 5_000_000;

export class SqlEngine {
  private readonly db = new DatabaseSync(":memory:");
  private readonly references = new Map<string, ReferenceTableInfo>();

  createReference(rows: Record<string, unknown>[], originalTokens: number, virtualizedTokens: number): ReferenceTableInfo {
    if (this.references.size >= MAX_REFERENCES) throw new Error("Reference table capacity reached. Restart HyperMCP to release local reference data.");
    if (rows.length > MAX_REFERENCE_ROWS) throw new Error("Reference exceeds the 100,000-row safety limit.");
    if (Buffer.byteLength(JSON.stringify(rows), "utf8") > MAX_REFERENCE_BYTES) throw new Error("Reference exceeds the 64 MiB safety limit.");
    const id = randomBytes(4).toString("hex");
    const pointer = `$ref:${id}`;
    const table = `ref_${id}`;
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const columns = keys.length ? keys : ["value"];
    if (columns.length > MAX_REFERENCE_COLUMNS) throw new Error("Reference exceeds the 200-column safety limit.");
    const schema = Object.fromEntries(columns.map((key) => [key, sqlType(rows.map((row) => row[key]))]));
    const definitions = columns.map((key) => `${quoteIdentifier(key)} ${schema[key]}`).join(", ");
    this.db.exec("BEGIN");
    try {
      this.db.exec(`CREATE TABLE ${quoteIdentifier(table)} (${definitions})`);
      const insert = this.db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      for (const row of rows.length ? rows : [{ value: null }]) insert.run(...columns.map((key) => toCell(row[key])));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const info: ReferenceTableInfo = {
      pointer,
      table,
      rowCount: rows.length,
      schema,
      createdAt: new Date().toISOString(),
      originalTokens,
      virtualizedTokens,
    };
    this.references.set(pointer, info);
    return info;
  }

  query(sql: string): Record<string, unknown>[] {
    if (sql.length > MAX_QUERY_LENGTH) throw new Error("SQL query exceeds the 8 KiB safety limit.");
    const rewritten = sql.replace(/\$ref:([a-f0-9]{8})\b/gi, "ref_$1");
    const normalized = rewritten.trim();
    if (!/^SELECT\b/i.test(normalized)) throw new Error("Only a single read-only SELECT query is allowed.");
    if (/--|\/\*/.test(normalized)) throw new Error("SQL comments are not allowed.");
    if (/\b(?:WITH|UNION|INTERSECT|EXCEPT|RANDOMBLOB|ZEROBLOB|READFILE|WRITEFILE|LOAD_EXTENSION)\b/i.test(normalized)) {
      throw new Error("This SQL feature is outside the supported analytical query subset.");
    }
    if (normalized.includes(";")) {
      const withoutOneTrailingSemicolon = normalized.replace(/;\s*$/, "");
      if (withoutOneTrailingSemicolon.includes(";")) throw new Error("Multiple SQL statements are not allowed.");
    }
    if (/\b(?:ATTACH|DETACH|PRAGMA|VACUUM|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE)\b/i.test(normalized)) {
      throw new Error("Only read-only analytical SQL is allowed.");
    }
    const tableMatches = [...normalized.matchAll(/\b(?:FROM|JOIN)\s+["']?(ref_[a-f0-9]{8})["']?/gi)];
    if (/\b(?:FROM|JOIN)\s+(?!["']?ref_[a-f0-9]{8}\b)/i.test(normalized)) throw new Error("Queries may read only HyperMCP $ref tables.");
    let scanEstimate = 1;
    for (const match of tableMatches) {
      const table = match[1];
      const info = [...this.references.values()].find((reference) => reference.table.toLowerCase() === table.toLowerCase());
      if (!info) throw new Error("Queries may read only active HyperMCP $ref tables.");
      scanEstimate *= Math.max(1, info.rowCount);
      if (scanEstimate > MAX_JOIN_SCAN_ESTIMATE) throw new Error("Estimated join scan exceeds the safety limit. Filter or split the query first.");
    }
    if (/\bJOIN\b/i.test(normalized) && !/\bJOIN\s+["']?ref_[a-f0-9]{8}["']?(?:\s+(?:AS\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s+ON\b/i.test(normalized)) {
      throw new Error("JOIN queries must include an ON condition.");
    }
    const statement = this.db.prepare(`SELECT * FROM (${normalized.replace(/;\s*$/, "")}) LIMIT ${MAX_QUERY_ROWS + 1}`);
    const rows: Record<string, unknown>[] = [];
    let resultBytes = 0;
    for (const row of statement.all()) {
      const record = Object.assign({}, row) as Record<string, unknown>;
      resultBytes += Buffer.byteLength(JSON.stringify(record), "utf8");
      if (resultBytes > MAX_QUERY_BYTES) throw new Error("Query exceeds the 16 MiB result limit.");
      rows.push(record);
    }
    if (rows.length > MAX_QUERY_ROWS) throw new Error("Query exceeds the 10,000-row result limit.");
    return rows;
  }

  hydratePointer(pointer: string): Record<string, unknown>[] {
    if (!this.references.has(pointer)) throw new Error(`Unknown reference pointer: ${pointer}`);
    return this.query(`SELECT * FROM ${pointer}`);
  }

  listReferences(): ReferenceTableInfo[] {
    return [...this.references.values()].map((info) => ({ ...info, schema: { ...info.schema } }));
  }

  get totalTokensSaved(): number {
    return this.listReferences().reduce((total, item) => total + Math.max(0, item.originalTokens - item.virtualizedTokens), 0);
  }

  close(): void {
    this.db.close();
  }
}
