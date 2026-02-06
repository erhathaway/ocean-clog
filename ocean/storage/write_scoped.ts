import { OceanError, ERR } from "../core/errors.js";
import type { SqlClient } from "../db/db.js";
import { deleteGlobalRow, deleteRunStorageRow, deleteSessionStorageRow, deleteTickRow, upsertGlobal, upsertRun, upsertSession, upsertTickRow } from "./storage.js";
import type { ReadLedger } from "./read_scoped.js";
import { deleteRunEntity, deleteSessionEntity } from "../engine/run.js";
import { deleteTickEntity } from "../engine/tick.js";

export type StorageWriteOp =
  // storage rows (non-cascading)
  | { op: "global.set"; value: unknown }
  | { op: "global.clear" }
  | { op: "session.set"; sessionId: string; value: unknown }
  | { op: "session.clear"; sessionId: string }
  | { op: "run.set"; runId: string; value: unknown }
  | { op: "run.clear"; runId: string }
  | { op: "tick.set"; runId: string; tickId: string; rowId: string; value: unknown }
  | { op: "tick.del"; runId: string; tickId: string; rowId: string }
  // entity deletes (cascading)
  | { op: "session.delete"; sessionId: string }
  | { op: "run.delete"; runId: string }
  | { op: "tick.delete"; runId: string; tickId: string };

export type WriteScopedInput = { ops: StorageWriteOp[] };
export type WriteScopedOutput = { ok: true; applied: number };

function require(cond: boolean, code: string, message: string, details?: unknown): void {
  if (!cond) throw new OceanError(code, message, details);
}

export async function storageWriteScoped(
  db: SqlClient,
  ctx: { clogId: string; sessionId: string; runId: string; tickId: string },
  input: WriteScopedInput,
  ledger: ReadLedger,
): Promise<WriteScopedOutput> {
  // Validate all ops before executing (fail fast on RBW violations).
  for (const op of input.ops) {
    if (op.op === "global.set" || op.op === "global.clear") {
      require(ledger.global, ERR.RBW_VIOLATION, "must read global row before writing global row");
    } else if (op.op === "session.set" || op.op === "session.clear") {
      require(op.sessionId === ctx.sessionId, ERR.INVALID_SCOPE, "sessionId does not match current tick context");
      require(ledger.session.has(op.sessionId), ERR.RBW_VIOLATION, "must read session row before writing session row", {
        sessionId: op.sessionId,
      });
    } else if (op.op === "session.delete") {
      require(op.sessionId === ctx.sessionId, ERR.INVALID_SCOPE, "sessionId does not match current tick context");
      require(ledger.session.has(op.sessionId), ERR.RBW_VIOLATION, "must read session row before deleting session entity", {
        sessionId: op.sessionId,
      });
    } else if (op.op === "run.set" || op.op === "run.clear") {
      require(op.runId === ctx.runId, ERR.INVALID_SCOPE, "runId does not match current tick context");
      require(ledger.run.has(op.runId), ERR.RBW_VIOLATION, "must read run row before writing run row", { runId: op.runId });
    } else if (op.op === "run.delete") {
      require(op.runId === ctx.runId, ERR.INVALID_SCOPE, "runId does not match current tick context");
      require(ledger.run.has(op.runId), ERR.RBW_VIOLATION, "must read run row before deleting run entity", { runId: op.runId });
    } else if (op.op === "tick.set" || op.op === "tick.del") {
      require(op.runId === ctx.runId && op.tickId === ctx.tickId, ERR.INVALID_SCOPE, "tick scope does not match current tick context");
      const k = `${op.runId}|${op.tickId}|${op.rowId}`;
      require(ledger.tickRows.has(k), ERR.RBW_VIOLATION, "must read tick row before writing tick row", {
        runId: op.runId,
        tickId: op.tickId,
        rowId: op.rowId,
      });
    } else if (op.op === "tick.delete") {
      require(op.runId === ctx.runId && op.tickId === ctx.tickId, ERR.INVALID_SCOPE, "tick scope does not match current tick context");
      require(ledger.tickRows.size > 0, ERR.RBW_VIOLATION, "must read at least one tick row before deleting tick entity");
    } else {
      throw new OceanError(ERR.INVALID_SCOPE, "unknown write op", op);
    }
  }

  let applied = 0;

  await db.transaction(async (tx) => {
    // tx (LibSQLTransaction) extends BaseSQLiteDatabase like LibSQLDatabase;
    // cast to SqlClient so storage helpers accept it.
    const d = tx as unknown as SqlClient;
    for (const op of input.ops) {
      if (op.op === "global.set") {
        await upsertGlobal(d, ctx.clogId, op.value);
      } else if (op.op === "global.clear") {
        await deleteGlobalRow(d, ctx.clogId);
      } else if (op.op === "session.set") {
        await upsertSession(d, ctx.clogId, op.sessionId, op.value);
      } else if (op.op === "session.clear") {
        await deleteSessionStorageRow(d, ctx.clogId, op.sessionId);
      } else if (op.op === "run.set") {
        await upsertRun(d, ctx.clogId, op.runId, op.value);
      } else if (op.op === "run.clear") {
        await deleteRunStorageRow(d, ctx.clogId, op.runId);
      } else if (op.op === "tick.set") {
        await upsertTickRow(d, ctx.clogId, op.runId, op.tickId, op.rowId, op.value);
      } else if (op.op === "tick.del") {
        await deleteTickRow(d, ctx.clogId, op.runId, op.tickId, op.rowId);
      } else if (op.op === "session.delete") {
        await deleteSessionEntity(d, op.sessionId);
      } else if (op.op === "run.delete") {
        await deleteRunEntity(d, op.runId);
      } else if (op.op === "tick.delete") {
        await deleteTickEntity(d, op.runId, op.tickId);
      }
      applied++;
    }
  });

  return { ok: true, applied };
}