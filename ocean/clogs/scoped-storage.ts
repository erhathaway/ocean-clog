export type GlobalStorageView = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
  del: (key: string) => Promise<void>;
  listKeys: (prefix?: string) => Promise<string[]>;
};

export type SessionStorageView = {
  sessionId: string;
  global: GlobalStorageView;

  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
  del: (key: string) => Promise<void>;
  listKeys: (prefix?: string) => Promise<string[]>;
};

export type RunStorageView = {
  runId: string;
  sessionId: string;

  global: GlobalStorageView;
  session: SessionStorageView;

  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
  del: (key: string) => Promise<void>;
  listKeys: (prefix?: string) => Promise<string[]>;
};

export type TickStorageView = {
  runId: string;
  tickId: string;
  sessionId: string;

  global: GlobalStorageView;
  session: SessionStorageView;
  run: RunStorageView;

  get: <T = unknown>(key: string) => Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
  del: (key: string) => Promise<void>;
  listKeys: (prefix?: string) => Promise<string[]>;
  clear: () => Promise<void>;
};