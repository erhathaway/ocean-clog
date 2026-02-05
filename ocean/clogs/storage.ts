export type ClogStorage = {
  global: {
    get: <T = unknown>(key: string) => Promise<T | undefined>;
    set: <T = unknown>(key: string, value: T) => Promise<void>;
    del: (key: string) => Promise<void>;
    listKeys: (prefix?: string) => Promise<string[]>;
  };

  session: {
    get: <T = unknown>(sessionId: string, key: string) => Promise<T | undefined>;
    set: <T = unknown>(sessionId: string, key: string, value: T) => Promise<void>;
    del: (sessionId: string, key: string) => Promise<void>;
    listKeys: (sessionId: string, prefix?: string) => Promise<string[]>;
  };

  run: {
    get: <T = unknown>(runId: string, key: string) => Promise<T | undefined>;
    set: <T = unknown>(runId: string, key: string, value: T) => Promise<void>;
    del: (runId: string, key: string) => Promise<void>;
    listKeys: (runId: string, prefix?: string) => Promise<string[]>;
  };

  tick: {
    get: <T = unknown>(runId: string, tickId: string, key: string) => Promise<T | undefined>;
    set: <T = unknown>(runId: string, tickId: string, key: string, value: T) => Promise<void>;
    del: (runId: string, tickId: string, key: string) => Promise<void>;
    listKeys: (runId: string, tickId: string, prefix?: string) => Promise<string[]>;
    clear: (runId: string, tickId: string) => Promise<void>; // handy
  };
};