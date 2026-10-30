import { randomUUID } from "node:crypto";
import type { AuditErrorCategory, JsonObject, SnapshotPlan, StagedTransaction, TransactionStatus, SQLiteOccMutation } from "../config/types.ts";
import { TransactionJournal, type AuditJournalHistory } from "./journal.ts";

export class StagingManager {
  private readonly transactions = new Map<string, StagedTransaction>();

  constructor(private readonly journal: TransactionJournal) {}

  create(input: {
    server: string;
    tool: string;
    arguments: JsonObject;
    snapshotPlan?: SnapshotPlan;
    sqliteOccMutation?: SQLiteOccMutation;
    before: unknown;
    previewAfter?: unknown;
    affectedRows: number;
  }): StagedTransaction {
    const id = "tx_" + randomUUID().replaceAll("-", "").slice(0, 10);
    const now = new Date().toISOString();
    const item: StagedTransaction = {
      ...input,
      id,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
      diffSummary: input.affectedRows + " row" + (input.affectedRows === 1 ? "" : "s") + " affected by " + input.tool,
    };
    this.journal.record(item);
    this.transactions.set(id, item);
    return item;
  }

  get(id: string): StagedTransaction {
    const item = this.transactions.get(id);
    if (!item) throw new Error("Transaction " + id + " was not found.");
    return item;
  }

  transition(id: string, status: TransactionStatus, updates: Partial<StagedTransaction> = {}): StagedTransaction {
    const item = this.get(id);
    const next = { ...item, ...updates, status, updatedAt: new Date().toISOString() };
    this.journal.record(next);
    this.transactions.set(id, next);
    return next;
  }

  list(): StagedTransaction[] {
    return [...this.transactions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  auditHistory(): AuditJournalHistory {
    return this.journal.history();
  }

  findAudit(id: string) {
    return this.journal.find(id);
  }

  updateHistorical(id: string, status: TransactionStatus, errorCategory?: AuditErrorCategory): void {
    this.journal.updateExisting(id, status, errorCategory);
  }

  close(): void {
    this.journal.close();
  }
}
