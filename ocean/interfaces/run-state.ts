export type RunState = {
  chain: Array<unknown>;
  stepIndex: number;

  // tick model
  tickIndex: number;
  activeTickId?: string;

  stepState?: unknown;
  lastOutput?: unknown;
  input?: unknown;
};