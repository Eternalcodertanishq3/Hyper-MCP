import type { StagedTransaction } from "../config/types.ts";

export interface SnapshotToolCaller {
  call(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export class RollbackEngine {
  constructor(private readonly caller: SnapshotToolCaller) {}

  async restore(transaction: StagedTransaction): Promise<unknown> {
    const plan = transaction.snapshotPlan;
    if (!plan) throw new Error("SNAPSHOT_PLAN_MISSING: transaction has no configured restore plan.");
    return this.caller.call(transaction.server, plan.restoreTool, { [plan.restoreArgumentKey]: transaction.before });
  }
}
