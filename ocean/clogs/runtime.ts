import { OceanError, ERR } from "../core/errors.js";
import type { SqlClient } from "../db/db.js";
import type { ClogRegistry } from "./registry.js";
import type { ToolCall, ToolInvoker, ToolResult } from "../tools/types.js";
import { toolEventsEmit } from "../tools/events_emit.js";
import { toolClogCall } from "../tools/clog_call.js";
import { storageReadScoped, type ReadLedger } from "../storage/read_scoped.js";
import { storageWriteScoped } from "../storage/write_scoped.js";

export type TickToolContext = {
  // tick execution context
  sessionId: string;
  runId: string;
  tickId: string;

  // current clog id (the caller)
  clogId: string;
};

export function createToolInvoker(opts: {
  db: SqlClient;
  registry: ClogRegistry;
  tickCtx: TickToolContext;

  // per-clog-per-tick storage budgets + RBW ledger
  readCalled: { value: boolean };
  writeCalled: { value: boolean };
  ledger: ReadLedger;

  // factory so nested clog calls get a fresh storage budget
  toolInvokerFactory: (clogId: string) => ToolInvoker;
}): ToolInvoker {
  const { db, registry, tickCtx, readCalled, writeCalled, ledger, toolInvokerFactory } = opts;

  return async (call: ToolCall): Promise<ToolResult> => {
    try {
      if (call.name === "ocean.events.emit") {
        const out = await toolEventsEmit(db, call.input as any);
        return { ok: true, output: out };
      }

      if (call.name === "ocean.clog.call") {
        const input = call.input as any;
        const m = /^clog\.([^.]+)\./.exec(input.address);
        if (!m) throw new OceanError(ERR.UNKNOWN_ENDPOINT, "invalid clog address", { address: input.address });
        const calleeClogId = m[1];

        const toolsForCallee = toolInvokerFactory(calleeClogId);
        const out = await toolClogCall(registry, toolsForCallee, input);
        return { ok: true, output: out };
      }

      if (call.name === "ocean.storage.read_scoped") {
        if (readCalled.value) {
          throw new OceanError(ERR.STORAGE_READ_ALREADY_CALLED, "storage.read_scoped already called for this clog in this tick");
        }
        readCalled.value = true;
        const out = await storageReadScoped(
          db,
          { clogId: tickCtx.clogId, sessionId: tickCtx.sessionId, runId: tickCtx.runId, tickId: tickCtx.tickId },
          call.input as any,
          ledger,
        );
        return { ok: true, output: out };
      }

      if (call.name === "ocean.storage.write_scoped") {
        if (!readCalled.value) {
          throw new OceanError(ERR.STORAGE_WRITE_BEFORE_READ, "storage.write_scoped called before storage.read_scoped");
        }
        if (writeCalled.value) {
          throw new OceanError(ERR.STORAGE_WRITE_ALREADY_CALLED, "storage.write_scoped already called for this clog in this tick");
        }
        writeCalled.value = true;
        const out = await storageWriteScoped(
          db,
          { clogId: tickCtx.clogId, sessionId: tickCtx.sessionId, runId: tickCtx.runId, tickId: tickCtx.tickId },
          call.input as any,
          ledger,
        );
        return { ok: true, output: out };
      }

      throw new OceanError(ERR.UNKNOWN_TOOL, "unknown tool", { name: call.name });
    } catch (e: any) {
      const code = e?.code ?? "OCEAN_TOOL_ERROR";
      const message = e?.message ?? String(e);
      const details = e?.details;
      return { ok: false, error: { code, message, details } };
    }
  };
}