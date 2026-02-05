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
  let applied = 0;

  // NOTE: For correctness, wrap these ops in a transaction at the db adapter layer.
  for (const op of input.ops) {
    if (op.op === "global.set") {
      require(ledger.global, ERR.RBW_VIOLATION, "must read global row before writing global row");
      await upsertGlobal(db, ctx.clogId, op.value);
      applied++;
      continue;
    }
    if (op.op === "global.clear") {
      require(ledger.global, ERR.RBW_VIOLATION, "must read global row before clearing global row");
      await deleteGlobalRow(db, ctx.clogId);
      applied++;
      continue;
    }

    if (op.op === "session.set") {
      require(op.sessionId === ctx.sessionId, ERR.INVALID_SCOPE, "sessionId does not match current tick context");
      require(ledger.session.has(op.sessionId), ERR.RBW_VIOLATION, "must read session row before writing session row", {
        sessionId: op.sessionId,
      });
      await upsertSession(db, ctx.clogId, op.sessionId, op.value);
      applied++;
      continue;
    }
    if (op.op === "session.clear") {
      require(op.sessionId === ctx.sessionId, ERR.INVALID_SCOPE, "sessionId does not match current tick context");
      require(ledger.session.has(op.sessionId), ERR.RBW_VIOLATION, "must read session row before clearing session row", {
        sessionId: op.sessionId,
      });
      await deleteSessionStorageRow(db, ctx.clogId, op.sessionId);
      applied++;
      continue;
    }

    if (op.op === "run.set") {
      require(op.runId === ctx.runId, ERR.INVALID_SCOPE, "runId does not match current tick context");
      require(ledger.run.has(op.runId), ERR.RBW_VIOLATION, "must read run row before writing run row", { runId: op.runId });
      await upsertRun(db, ctx.clogId, op.runId, op.value);
      applied++;
      continue;
    }
    if (op.op === "run.clear") {
      require(op.runId === ctx.runId, ERR.INVALID_SCOPE, "runId does not match current tick context");
      require(ledger.run.has(op.runId), ERR.RBW_VIOLATION, "must read run row before clearing run row", { runId: op.runId });
      await deleteRunStorageRow(db, ctx.clogId, op.runId);
      applied++;
      continue;
    }

    if (op.op === "tick.set") {
      require(op.runId === ctx.runId && op.tickId === ctx.tickId, ERR.INVALID_SCOPE, "tick scope does not match current tick context");
      const k = `${op.runId}|${op.tickId}|${op.rowId}`;
      require(ledger.tickRows.has(k), ERR.RBW_VIOLATION, "must read tick row before writing tick row", {
        runId: op.runId,
        tickId: op.tickId,
        rowId: op.rowId,
      });
      await upsertTickRow(db, ctx.clogId, op.runId, op.tickId, op.rowId, op.value);
      applied++;
      continue;
    }

    if (op.op === "tick.del") {
      require(op.runId === ctx.runId && op.tickId === ctx.tickId, ERR.INVALID_SCOPE, "tick scope does not match current tick context");
      const k = `${op.runId}|${op.tickId}|${op.rowId}`;
      require(ledger.tickRows.has(k), ERR.RBW_VIOLATION, "must read tick row before deleting tick row", {
        runId: op.runId,
        tickId: op.tickId,
        rowId: op.rowId,
      });
      await deleteTickRow(db, ctx.clogId, op.runId, op.tickId, op.rowId);
      applied++;
      continue;
    }

    // Entity deletes (cascading). Still require reading the corresponding singleton first.
    if (op.op === "session.delete") {
      require(op.sessionId === ctx.sessionId, ERR.INVALID_SCOPE, "sessionId does not match current tick context");
      require(ledger.session.has(op.sessionId), ERR.RBW_VIOLATION, "must read session row before deleting session entity", {
        sessionId: op.sessionId,
      });
      await deleteSessionEntity(db, op.sessionId);
      applied++;
      continue;
    }

    if (op.op === "run.delete") {
      require(op.runId === ctx.runId, ERR.INVALID_SCOPE, "runId does not match current tick context");
      require(ledger.run.has(op.runId), ERR.RBW_VIOLATION, "must read run row before deleting run entity", { runId: op.runId });
      await deleteRunEntity(db, op.runId);
      applied++;
      continue;
    }

    if (op.op === "tick.delete") {
      require(op.runId === ctx.runId && op.tickId === ctx.tickId, ERR.INVALID_SCOPE, "tick scope does not match current tick context");
      // tick entity delete requires that the caller read at least one tick row id they are “touching”.
      // If you want stricter semantics, require a specific reserved rowId (e.g. "_tick") be read.
      // For simplicity: require that any tick row was read in this tick.
      require(ledger.tickRows.size > 0, ERR.RBW_VIOLATION, "must read at least one tick row before deleting tick entity");
      await deleteTickEntity(db, op.runId, op.tickId);
      applied++;
      continue;
    }

    throw new OceanError(ERR.INVALID_SCOPE, "unknown write op", op);
  }

  return { ok: true, applied };
}