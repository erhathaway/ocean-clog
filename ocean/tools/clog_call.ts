import { OceanError, ERR } from "../core/errors.js";
import type { ClogRegistry } from "../clogs/registry.js";
import type { ToolInvoker } from "./types.js";

export type ClogCallInput = { address: string; payload?: unknown };
export type ClogCallOutput = { ok: true; result?: unknown };

export async function toolClogCall(
  registry: ClogRegistry,
  toolsForCallee: ToolInvoker,
  input: ClogCallInput,
): Promise<ClogCallOutput> {
  const m = /^clog\.([^.]+)\.([^.]+)$/.exec(input.address);
  if (!m) throw new OceanError(ERR.UNKNOWN_ENDPOINT, "invalid clog address", { address: input.address });

  const [, clogId, method] = m;
  const handler = registry.getHandler(clogId, method);
  if (!handler) throw new OceanError(ERR.UNKNOWN_ENDPOINT, "unknown clog endpoint", { clogId, method });

  const result = await handler(input.payload, { tools: toolsForCallee });
  return { ok: true, result };
}