import type { Clog, TickOutcome } from "../clogs/types.js";

/**
 * A minimal chat clog demonstrating:
 * - exactly 1 read_scoped call and 1 write_scoped call
 * - exact-row RBW for tick rows
 * - streaming output via events.emit (unlimited)
 * - bulk tick history hydration (does NOT unlock writes)
 *
 * Storage conventions used here:
 * - run row (single JSON): { messages: Array<{role, content, tickId}> }
 * - tick rows:
 *   - "user_message": { content: string }
 *   - "assistant_message": { content: string }
 */
export const chatClog: Clog = {
  id: "chat",

  async onAdvance(input, { tools, attempt }): Promise<TickOutcome> {
    const { userText } = (input as any) ?? {};
    if (!userText) return { status: "ok" };

    const assistantText = `You said: ${String(userText)}`;

    // In a real clog you'd use tools to read/write storage, emit events, etc.
    // This is a minimal demonstration of the onAdvance pattern.
    return { status: "done", output: { assistantText } };
  },

  endpoints: {
    /**
     * Address: clog.chat.onMessage
     * Payload: { runId, tickId, userText }
     *
     * Note: runId/tickId are also in Ocean's tick context. This payload repeats them
     * only to show typical plumbing; in a real app you may not need them here.
     */
    async onMessage(payload: any, ctx) {
      const { runId, tickId, userText } = payload ?? {};
      if (!runId || !tickId) throw new Error("runId and tickId required");

      // --- 1) READ (the only storage read call)
      // Read exact rows we intend to update:
      // - run row (to append messages)
      // - tick rows "user_message" and "assistant_message"
      // Also read history for hydration (does not unlock writes).
      const read = await ctx.tools({
        name: "ocean.storage.read_scoped",
        input: {
          plans: [
            { kind: "run", runId },
            { kind: "tick_rows", runId, tickId, rowIds: ["user_message", "assistant_message"] },
            { kind: "history_ticks_for_run", runId, rowIds: ["user_message", "assistant_message"], limitTicks: 25, order: "asc" },
          ],
        },
      });

      if (!read.ok) throw new Error(`read_scoped failed: ${read.error.code}: ${read.error.message}`);

      // Extract run state
      const snapshot = (read.output as any).snapshot as any[];
      const runSnap = snapshot.find((s) => s.type === "run");
      const existingRun = runSnap?.value ?? { messages: [] };

      // --- compute / stream (unlimited other tool calls)
      // Store user message locally (we'll commit in write_scoped)
      const assistantText = `You said: ${String(userText ?? "")}`;

      // Simulate streaming deltas
      for (const chunk of assistantText.split(" ")) {
        const ev = await ctx.tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run", runId },
            type: "run.delta",
            payload: { text: chunk + " " },
          },
        });
        if (!ev.ok) throw new Error(`events.emit failed: ${ev.error.code}: ${ev.error.message}`);
      }

      // Build new run messages
      const newMessages = Array.isArray(existingRun.messages) ? existingRun.messages.slice() : [];
      newMessages.push({ role: "user", content: String(userText ?? ""), tickId });
      newMessages.push({ role: "assistant", content: assistantText, tickId });

      // --- 2) WRITE (the only storage write call)
      const write = await ctx.tools({
        name: "ocean.storage.write_scoped",
        input: {
          ops: [
            // update run row (allowed because we read run row)
            { op: "run.set", runId, value: { ...existingRun, messages: newMessages } },

            // update tick rows (allowed because we read these exact rowIds)
            { op: "tick.set", runId, tickId, rowId: "user_message", value: { content: String(userText ?? "") } },
            { op: "tick.set", runId, tickId, rowId: "assistant_message", value: { content: assistantText } },
          ],
        },
      });

      if (!write.ok) throw new Error(`write_scoped failed: ${write.error.code}: ${write.error.message}`);

      return { ok: true, assistantText };
    },
  },
};