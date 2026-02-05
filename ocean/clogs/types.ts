import type { ToolInvoker } from "../tools/types.js";

export type ClogHandler = (payload: unknown, ctx: { tools: ToolInvoker }) => Promise<unknown>;

export type Clog = {
  id: string;
  endpoints: Record<string, ClogHandler>; // method -> handler
};