import type { ToolInvoker } from "../tools/types.js";

export type ClogHandler = (payload: unknown, ctx: { tools: ToolInvoker }) => Promise<unknown>;

export type TickOutcome =
  | { status: "ok" }
  | { status: "done"; output?: unknown }
  | { status: "continue"; input?: unknown }
  | { status: "wait"; wakeAt: number }
  | { status: "retry"; error: string }
  | { status: "failed"; error: string };

export type AdvanceHandler = (
  input: unknown,
  ctx: { tools: ToolInvoker; attempt: number },
) => Promise<TickOutcome>;

export type Clog = {
  id: string;
  endpoints: Record<string, ClogHandler>;
  onAdvance?: AdvanceHandler;
};
