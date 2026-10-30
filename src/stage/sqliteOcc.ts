/**
 * Deliberately small SQLite OCC adapter. It accepts only one-row UPDATE and
 * DELETE statements, parses them into data, then emits a guarded statement.
 * SQL supplied by an agent is never forwarded to the upstream write tool.
 */

import type { SQLiteOccMutation, SQLiteOccSchema, SQLiteOccTableConfig, SQLiteOccValue } from "../config/types.ts";

type Token = { kind: "word" | "string" | "integer" | "equals" | "comma"; value: string | number };

function fail(message: string): never {
  throw new Error("SQLITE_OCC_REJECTED: " + message);
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

function tokenize(sql: string): Token[] {
  if (sql.length > 16_384) fail("statement exceeds 16 KiB.");
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === ";" || sql.startsWith("--", index) || sql.startsWith("/*", index) || sql.startsWith("*/", index) || char === "\0") {
      fail("comments, statement separators, and NUL bytes are not supported.");
    }
    if (char === "=") { tokens.push({ kind: "equals", value: char }); index += 1; continue; }
    if (char === ",") { tokens.push({ kind: "comma", value: char }); index += 1; continue; }
    if (char === "'") {
      index += 1;
      let value = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") { value += "'"; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        if (sql[index] === "\0") fail("NUL bytes are not supported in text values.");
        value += sql[index++];
      }
      if (!closed) fail("unterminated text literal.");
      tokens.push({ kind: "string", value });
      continue;
    }
    if (char === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') { value += '"'; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += sql[index++];
      }
      if (!closed || !validIdentifier(value)) fail("quoted identifiers must be simple ASCII SQLite identifiers.");
      tokens.push({ kind: "word", value });
      continue;
    }
    const integer = sql.slice(index).match(/^-?(?:0|[1-9][0-9]*)/);
    if (integer) {
      const value = Number(integer[0]);
      if (!Number.isSafeInteger(value)) fail("integer literals must be within JavaScript's safe integer range.");
      tokens.push({ kind: "integer", value });
      index += integer[0].length;
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]{0,127}/);
    if (word) {
      if (/^(?:true|false)$/i.test(word[0])) fail("boolean literals are not supported; use 0 or 1 explicitly.");
      tokens.push({ kind: "word", value: word[0] });
      index += word[0].length;
      continue;
    }
    fail("unsupported SQL token at character " + index + ".");
  }
  return tokens;
}

function sameIdentifier(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

/** Parses UPDATE table SET col=literal[, ...] WHERE pk=literal or DELETE FROM table WHERE pk=literal. */
export function parseSQLiteOccMutation(sql: string, tables: SQLiteOccTableConfig[]): SQLiteOccMutation {
  const tokens = tokenize(sql);
  let offset = 0;
  const peek = () => tokens[offset];
  const take = (kind: Token["kind"], expected: string): Token => {
    const token = tokens[offset++];
    if (!token || token.kind !== kind) fail("expected " + expected + ".");
    return token;
  };
  const keyword = (expected: string) => {
    const token = take("word", expected);
    if (String(token.value).toUpperCase() !== expected) fail("expected " + expected + ".");
  };
  const identifier = () => String(take("word", "an identifier").value);
  const literal = (): SQLiteOccValue => {
    const token = peek();
    if (token?.kind === "string" || token?.kind === "integer") { offset += 1; return token.value as string | number; }
    if (token?.kind === "word" && String(token.value).toUpperCase() === "NULL") { offset += 1; return null; }
    fail("only INTEGER, TEXT, and NULL literals are supported.");
  };

  const first = peek();
  if (!first || first.kind !== "word") fail("statement must be UPDATE or DELETE.");
  let operation: "update" | "delete";
  let table: string;
  const assignments: Record<string, SQLiteOccValue> = {};
  if (String(first.value).toUpperCase() === "UPDATE") {
    offset += 1;
    operation = "update";
    table = identifier();
    keyword("SET");
    while (true) {
      const column = identifier();
      if (Object.hasOwn(assignments, column)) fail("duplicate column assignment: " + column + ".");
      take("equals", "=");
      assignments[column] = literal();
      if (peek()?.kind !== "comma") break;
      offset += 1;
    }
    keyword("WHERE");
  } else if (String(first.value).toUpperCase() === "DELETE") {
    offset += 1;
    operation = "delete";
    keyword("FROM");
    table = identifier();
    keyword("WHERE");
  } else {
    fail("statement must be UPDATE or DELETE.");
  }
  const keyColumn = identifier();
  take("equals", "=");
  const key = literal();
  if (key === null) fail("the target key cannot be NULL.");
  if (offset !== tokens.length) fail("only one equality predicate on the configured key is supported.");

  const target = tables.find((candidate) => sameIdentifier(candidate.name, table));
  if (!target) fail("table is not explicitly allowlisted.");
  if (!sameIdentifier(target.primaryKey, keyColumn)) fail("the WHERE clause must target the configured primary or unique key.");
  if (operation === "update") {
    if (Object.keys(assignments).length === 0) fail("UPDATE must assign at least one column.");
    for (const column of Object.keys(assignments)) {
      if (!target.allowedColumns.some((allowed) => sameIdentifier(allowed, column))) fail("column is not explicitly allowlisted: " + column + ".");
      if (sameIdentifier(column, target.primaryKey)) fail("primary and unique key columns cannot be changed.");
    }
    return { operation, table: target.name, primaryKey: target.primaryKey, key, assignments };
  }
  return { operation, table: target.name, primaryKey: target.primaryKey, key };
}

export function validateSQLiteOccSchema(input: {
  table: string;
  primaryKey: string;
  allowedColumns: string[];
  tableRows: Record<string, unknown>[];
  columnRows: Record<string, unknown>[];
  indexRows: Record<string, unknown>[];
}): SQLiteOccSchema {
  const { table, primaryKey, allowedColumns } = input;
  if (input.tableRows.length !== 1 || input.tableRows[0].type !== "table") {
    throw new Error("SQLITE_OCC_SCHEMA_ERROR: " + table + " must be a regular table in SQLite's main database.");
  }
  if (input.columnRows.length === 0) throw new Error("SQLITE_OCC_SCHEMA_ERROR: table not found or has no columns: " + table + ".");
  const columns = input.columnRows.map((row) => String(row.name ?? ""));
  if (columns.some((name) => !validIdentifier(name)) || new Set(columns.map((name) => name.toLocaleLowerCase("en-US"))).size !== columns.length) {
    throw new Error("SQLITE_OCC_SCHEMA_ERROR: table columns must have unique, simple ASCII names.");
  }
  if (input.columnRows.some((row) => Number(row.hidden) !== 0)) {
    throw new Error("SQLITE_OCC_SCHEMA_ERROR: generated, hidden, and virtual-table columns are not supported.");
  }
  const keyColumn = input.columnRows.find((row) => sameIdentifier(String(row.name), primaryKey));
  if (!keyColumn) throw new Error("SQLITE_OCC_SCHEMA_ERROR: configured key column does not exist: " + primaryKey + ".");

  const primaryKeyColumns = input.columnRows.filter((row) => Number(row.pk) > 0);
  let uniqueKeyIsEnforced = primaryKeyColumns.length === 1 && sameIdentifier(String(primaryKeyColumns[0].name), primaryKey);
  if (!uniqueKeyIsEnforced) {
    const indexes = new Map<string, { unique: boolean; partial: boolean; keyColumns: Array<{ cid: number; name: string | null }> }>();
    for (const row of input.indexRows) {
      const name = String(row.index_name ?? "");
      if (!name) continue;
      let index = indexes.get(name);
      if (!index) {
        index = { unique: Number(row.is_unique) === 1, partial: Number(row.partial) === 1, keyColumns: [] };
        indexes.set(name, index);
      }
      if (Number(row.is_key) === 1) index.keyColumns.push({ cid: Number(row.cid), name: row.column_name == null ? null : String(row.column_name) });
    }
    uniqueKeyIsEnforced = [...indexes.values()].some((index) => index.unique && !index.partial && index.keyColumns.length === 1 && index.keyColumns[0].cid >= 0 && index.keyColumns[0].name !== null && sameIdentifier(index.keyColumns[0].name, primaryKey));
  }
  if (!uniqueKeyIsEnforced) {
    throw new Error("SQLITE_OCC_SCHEMA_ERROR: configured key " + primaryKey + " is not backed by a single-column primary key or unconditional unique index.");
  }
  if (allowedColumns.some((column) => !columns.some((existing) => sameIdentifier(existing, column)) || sameIdentifier(column, primaryKey))) {
    throw new Error("SQLITE_OCC_SCHEMA_ERROR: allowedColumns must name existing, non-key columns.");
  }
  return { table: String(input.tableRows[0].name), primaryKey: String(keyColumn.name), columns };
}

export function quoteSQLiteIdentifier(identifier: string): string {
  if (!validIdentifier(identifier)) throw new Error("SQLITE_OCC_SCHEMA_ERROR: unsupported SQLite identifier.");
  return '"' + identifier.replaceAll('"', '""') + '"';
}

export function quoteSQLiteText(value: string): string {
  if (value.includes("\0")) fail("NUL bytes are not supported in text values.");
  return "'" + value.replaceAll("'", "''") + "'";
}

export function sqliteLiteral(value: SQLiteOccValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return quoteSQLiteText(value);
  if (!Number.isSafeInteger(value)) fail("only safe SQLite INTEGER values are supported.");
  return String(value);
}

function typedEquality(column: string, value: SQLiteOccValue): string {
  const identifier = quoteSQLiteIdentifier(column);
  if (value === null) return "typeof(" + identifier + ") = 'null' AND " + identifier + " IS NULL";
  if (typeof value === "string") return "typeof(" + identifier + ") = 'text' AND " + identifier + " = " + quoteSQLiteText(value) + " COLLATE BINARY";
  if (!Number.isSafeInteger(value)) fail("REAL values are not supported in optimistic comparisons.");
  return "typeof(" + identifier + ") = 'integer' AND " + identifier + " = " + String(value);
}

export function buildSQLiteOccReadQuery(schema: SQLiteOccSchema, key: string | number): string {
  if (key === null || (typeof key === "number" && !Number.isSafeInteger(key))) fail("key must be non-null TEXT or a safe INTEGER.");
  return "SELECT " + schema.columns.map(quoteSQLiteIdentifier).join(", ") + " FROM " + quoteSQLiteIdentifier(schema.table) +
    " WHERE " + typedEquality(schema.primaryKey, key) + " LIMIT 2";
}

export function validateSQLiteOccRow(value: unknown, schema: SQLiteOccSchema): Record<string, SQLiteOccValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SQLITE_OCC_PROTOCOL_ERROR: read tool rows must be JSON objects.");
  const row = value as Record<string, unknown>;
  if (schema.columns.length !== Object.keys(row).length || schema.columns.some((column) => !Object.hasOwn(row, column))) {
    throw new Error("SQLITE_OCC_PROTOCOL_ERROR: read tool returned columns that do not match the inspected SQLite schema.");
  }
  const result: Record<string, SQLiteOccValue> = {};
  for (const column of schema.columns) {
    const cell = row[column];
    if (cell === null || typeof cell === "string") result[column] = cell;
    else if (typeof cell === "number" && Number.isSafeInteger(cell)) result[column] = cell;
    else throw new Error("SQLITE_OCC_UNSUPPORTED_VALUE: column " + column + " contains a REAL, BLOB, or non-JSON SQLite value; no write was dispatched.");
  }
  return result;
}

export function buildSQLiteOccWriteQuery(mutation: SQLiteOccMutation, schema: SQLiteOccSchema, before: Record<string, SQLiteOccValue>): string {
  const guards = schema.columns.map((column) => typedEquality(column, before[column]));
  if (mutation.operation === "delete") {
    return "DELETE FROM " + quoteSQLiteIdentifier(schema.table) + " WHERE " + guards.join(" AND ");
  }
  const assignments = Object.entries(mutation.assignments).map(([column, value]) => quoteSQLiteIdentifier(column) + " = " + sqliteLiteral(value));
  return "UPDATE " + quoteSQLiteIdentifier(schema.table) + " SET " + assignments.join(", ") + " WHERE " + guards.join(" AND ");
}

export function buildSQLiteOccRestoreQuery(schema: SQLiteOccSchema, before: Record<string, SQLiteOccValue>, after: Record<string, SQLiteOccValue> | undefined): string {
  if (!after) {
    const columns = schema.columns.map(quoteSQLiteIdentifier).join(", ");
    const values = schema.columns.map((column) => sqliteLiteral(before[column])).join(", ");
    return "INSERT INTO " + quoteSQLiteIdentifier(schema.table) + " (" + columns + ") VALUES (" + values + ")";
  }
  const assignments = schema.columns.filter((column) => column !== schema.primaryKey)
    .map((column) => quoteSQLiteIdentifier(column) + " = " + sqliteLiteral(before[column]));
  if (assignments.length === 0) throw new Error("SQLITE_OCC_RESTORE_UNSUPPORTED: no mutable columns are available.");
  const guards = schema.columns.map((column) => typedEquality(column, after[column]));
  return "UPDATE " + quoteSQLiteIdentifier(schema.table) + " SET " + assignments.join(", ") + " WHERE " + guards.join(" AND ");
}

export function sameSQLiteOccRow(left: Record<string, SQLiteOccValue> | undefined, right: Record<string, SQLiteOccValue> | undefined): boolean {
  if (!left || !right) return left === right;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
