import { OceanError, ERR } from "../core/errors.js";
import type { SqlClient } from "../db/db.js";
import { readGlobal, readRun, readSession, readTickRows } from "./storage.js";
import { readTickHistoryForRun } from "./history.js";

export type StorageReadPlan =
  | { kind: "global" }
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string }
  | { kind: "tick_rows"; runId: string; tickId: string; rowIds: string[] }
  | { kind: "history_ticks_for_run"; runId: string; rowIds?: string[]; limitTicks?: number; order?: "asc" | "desc" };

export type ReadScopedInput = { plans: StorageReadPlan[] };

export type ReadScopedOutput = {
  ok: true;
  snapshot: Array<
    | { type: "global"; value?: unknown }
    | { type: "session"; sessionId: string; value?: unknown }
    | { type: "run"; runId: string; value?: unknown }
    | { type: "tick_rows"; runId: string; tickId: string; rows: Record<string, unknown> }
    | { type: "history_ticks"; runId: string; ticks: Array<{ tickId: string; updatedTs: number; rows: Record<string, unknown> }> }
  >;
};

export type ReadLedger = {
  global: boolean;
  session: Set<string>; // sessionId
  run: Set<string>;     // runId
  tickRows: Set<string>; // `${runId}|${tickId}|${rowId}`
};

export async function storageReadScoped(
  db: SqlClient,
  ctx: { clogId: string; sessionId: string; runId: string; tickId: string },
  input: ReadScopedInput,
  ledger: ReadLedger,
): Promise<ReadScopedOutput> {
  const snapshot: ReadScopedOutput["snapshot"] = [];

  for (const plan of input.plans) {
    if (plan.kind === "global") {
      const value = await readGlobal(db, ctx.clogId);
      ledger.global = true;
      snapshot.push({ type: "global", value });
      continue;
    }

    if (plan.kind === "session") {
      if (plan.sessionId !== ctx.sessionId) {
        throw new OceanError(ERR.INVALID_SCOPE, "sessionId does not match current tick context", {
          expected: ctx.sessionId,
          got: plan.sessionId,
        });
      }
      const value = await readSession(db, ctx.clogId, plan.sessionId);
      ledger.session.add(plan.sessionId);
      snapshot.push({ type: "session", sessionId: plan.sessionId, value });
      continue;
    }

    if (plan.kind === "run") {
      if (plan.runId !== ctx.runId) {
        throw new OceanError(ERR.INVALID_SCOPE, "runId does not match current tick context", {
          expected: ctx.runId,
          got: plan.runId,
        });
      }
      const value = await readRun(db, ctx.clogId, plan.runId);
      ledger.run.add(plan.runId);
      snapshot.push({ type: "run", runId: plan.runId, value });
      continue;
    }

    if (plan.kind === "tick_rows") {
      if (plan.runId !== ctx.runId || plan.tickId !== ctx.tickId) {
        throw new OceanError(ERR.INVALID_SCOPE, "tick scope does not match current tick context", {
          expected: { runId: ctx.runId, tickId: ctx.tickId },
          got: { runId: plan.runId, tickId: plan.tickId },
        });
      }
      const rows = await readTickRows(db, ctx.clogId, plan.runId, plan.tickId, plan.rowIds);
      for (const rowId of plan.rowIds) ledger.tickRows.add(`${plan.runId}|${plan.tickId}|${rowId}`);
      snapshot.push({ type: "tick_rows", runId: plan.runId, tickId: plan.tickId, rows });
      continue;
    }

    if (plan.kind === "history_ticks_for_run") {
      if (plan.runId !== ctx.runId) {
        throw new OceanError(ERR.INVALID_SCOPE, "history runId does not match current tick context", {
          expected: ctx.runId,
          got: plan.runId,
        });
      }
      const ticks = await readTickHistoryForRun(
        db,
        ctx.clogId,
        plan.runId,
        plan.rowIds,
        plan.limitTicks ?? 50,
        plan.order ?? "desc",
      );
      snapshot.push({ type: "history_ticks", runId: plan.runId, ticks });
      continue;
    }

    throw new OceanError(ERR.INVALID_SCOPE, "unknown read plan", plan);
  }

  return { ok: true, snapshot };
}