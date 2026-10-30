import type { ReferenceTableInfo } from "../config/types.ts";
import { estimateTokens } from "../core/tokenizer.ts";
import { SqlEngine } from "./sqlEngine.ts";

function objectRows(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) return value as Record<string, unknown>[];
  if (!value || typeof value !== "object") return undefined;
  const candidates = Object.values(value as Record<string, unknown>).map(objectRows).filter((rows): rows is Record<string, unknown>[] => Boolean(rows));
  return candidates.sort((a, b) => b.length - a.length)[0];
}

export type VirtualizationResult = { virtualized: false; value: unknown; originalTokens: number } | { virtualized: true; receipt: Record<string, unknown>; info: ReferenceTableInfo };

export function virtualizeOutput(value: unknown, thresholdTokens: number, sql: SqlEngine): VirtualizationResult {
  const originalTokens = estimateTokens(value);
  const rows = objectRows(value);
  if (originalTokens <= thresholdTokens || !rows?.length) return { virtualized: false, value, originalTokens };
  const info = sql.createReference(rows, originalTokens, 80);
  const receipt = {
    virtualized: true,
    pointer: info.pointer,
    row_count: info.rowCount,
    original_tokens: originalTokens,
    virtualized_tokens: 80,
    tokens_saved_pct: ((1 - 80 / originalTokens) * 100).toFixed(1) + "%",
    schema: info.schema,
    sample_rows: rows.slice(0, 2),
    hint: "Use hypermcp_query_ref with " + info.pointer + " or hypermcp_pipe_data to move rows to another MCP tool.",
  };
  return { virtualized: true, receipt, info };
}
