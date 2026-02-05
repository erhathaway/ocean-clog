export class OceanError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const ERR = {
  RBW_VIOLATION: "OCEAN_RBW_VIOLATION",
  STORAGE_READ_ALREADY_CALLED: "OCEAN_STORAGE_READ_ALREADY_CALLED",
  STORAGE_WRITE_ALREADY_CALLED: "OCEAN_STORAGE_WRITE_ALREADY_CALLED",
  STORAGE_WRITE_BEFORE_READ: "OCEAN_STORAGE_WRITE_BEFORE_READ",
  INVALID_SCOPE: "OCEAN_INVALID_SCOPE",
  UNKNOWN_TOOL: "OCEAN_UNKNOWN_TOOL",
  UNKNOWN_CLOG: "OCEAN_UNKNOWN_CLOG",
  UNKNOWN_ENDPOINT: "OCEAN_UNKNOWN_ENDPOINT",
} as const;