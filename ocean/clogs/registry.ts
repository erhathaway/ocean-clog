import type { Clog } from "./types.js";

export class ClogRegistry {
  private clogs = new Map<string, Clog>();

  register(clog: Clog): void {
    this.clogs.set(clog.id, clog);
  }

  getHandler(clogId: string, method: string) {
    const clog = this.clogs.get(clogId);
    return clog?.endpoints?.[method];
  }
}