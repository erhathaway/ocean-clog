export type ToolCall = { name: string; input: unknown };

export type ToolError = { code: string; message: string; details?: unknown };

export type ToolResult =
  | { ok: true; output: unknown }
  | { ok: false; error: ToolError };

export type ToolInvoker = (call: ToolCall) => Promise<ToolResult>;