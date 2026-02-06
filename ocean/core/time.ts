let _clock: (() => number) | null = null;

export function nowMs(): number {
  return _clock ? _clock() : Date.now();
}

export function _setTestClock(fn: (() => number) | null): void {
  _clock = fn;
}