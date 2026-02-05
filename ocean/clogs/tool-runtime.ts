export type ToolCall = {
  name: string;
  input: unknown;
};

export type ToolResult = {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type ToolInvoker = (call: ToolCall) => Promise<ToolResult>;