import type { AdvanceHandler, Clog } from "./types.js";

export class ClogRegistry {
  private clogs = new Map<string, Clog>();

  register(clog: Clog): void {
    this.clogs.set(clog.id, clog);
  }

  getHandler(clogId: string, method: string) {
    const clog = this.clogs.get(clogId);
    return clog?.endpoints?.[method];
  }

  getAdvanceHandler(clogId: string): AdvanceHandler | undefined {
    return this.clogs.get(clogId)?.onAdvance;
  }

  getClog(clogId: string): Clog | undefined {
    return this.clogs.get(clogId);
  }
}