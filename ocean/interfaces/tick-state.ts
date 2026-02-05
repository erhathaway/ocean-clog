export type RunState = {
  chain: Array<unknown>;
  stepIndex: number;

  // tick model
  tickIndex: number;              // increments per chat message / tick
  activeTickId?: string;          // optional uuid for current tick
};