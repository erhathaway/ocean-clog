/**
 * Task Manager Agent — a persistent assistant that manages scheduled jobs
 *
 * One long-lived run per user. The agent:
 *   - Receives user messages via signal()
 *   - Maintains a task list in run storage (CRUD via natural language)
 *   - Wakes on schedule to execute due tasks (scrape, fetch, notify)
 *   - Chains multi-step task execution across ticks via "continue"
 *   - Sleeps until the next event (message or scheduled task)
 *
 * Steps within a single advance cycle:
 *
 *   "message"  — parse user intent, mutate task list, reply
 *   "check"    — find due tasks, pick the first one, continue to "execute"
 *   "execute"  — run the task action (fetch URL, scrape, call API)
 *   "deliver"  — send the result somewhere (WhatsApp, Slack, email)
 *   "schedule" — mark task as done, compute next_run, wait until soonest event
 */

import type { Clog, TickOutcome } from "../clogs/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Task = {
  id: string;
  name: string;
  action: TaskAction;
  intervalMs: number;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number;
  deliver: DeliverTarget;
};

type TaskAction =
  | { type: "fetch_url"; url: string; extract?: string }
  | { type: "hn_top"; count: number }
  | { type: "custom"; description: string };

type DeliverTarget =
  | { type: "whatsapp"; to: string }
  | { type: "slack"; webhookUrl: string }
  | { type: "event_only" };

type AgentState = {
  tasks: Task[];
  messageHistory: Array<{ role: string; content: string; ts: number }>;
};

type StepInput =
  | { step: "message"; text: string }
  | { step: "check" }
  | { step: "execute"; taskId: string; data: unknown }
  | { step: "deliver"; taskId: string; result: string }
  | { step: "schedule"; taskId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextId(): string {
  return `task_${Date.now().toString(36)}`;
}

function parseInterval(s: string): number | null {
  const m = s.match(/(\d+)\s*(min|hour|day|h|d|m)/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "min" || unit === "m") return n * 60_000;
  if (unit === "hour" || unit === "h") return n * 3_600_000;
  if (unit === "day" || unit === "d") return n * 86_400_000;
  return null;
}

function soonestWakeAt(tasks: Task[]): number {
  const enabled = tasks.filter((t) => t.enabled);
  if (enabled.length === 0) return Date.now() + 86_400_000; // 24h default
  return Math.min(...enabled.map((t) => t.nextRun));
}

// ---------------------------------------------------------------------------
// The clog
// ---------------------------------------------------------------------------

export const taskManagerClog: Clog = {
  id: "task_manager",

  async onAdvance(input, { tools }): Promise<TickOutcome> {
    // --- Load state ---
    const read = await tools({
      name: "ocean.storage.read_scoped",
      input: { plans: [{ kind: "run" }] },
    });
    if (!read.ok) return { status: "retry", error: read.error.message };

    const state: AgentState = ((read.output as any).snapshot?.[0]?.value as AgentState) ?? {
      tasks: [],
      messageHistory: [],
    };

    const msg = (input ?? { step: "check" }) as StepInput;

    switch (msg.step) {
      // ---------------------------------------------------------------
      // User sent a message — parse intent, mutate task list, reply
      // ---------------------------------------------------------------
      case "message": {
        state.messageHistory.push({ role: "user", content: msg.text, ts: Date.now() });

        // --- Intent parsing (pseudo — replace with LLM call) ---
        // const intent = await llm.parse(msg.text, state.tasks);
        const reply = processCommand(msg.text, state);

        state.messageHistory.push({ role: "assistant", content: reply, ts: Date.now() });

        // Trim history to last 50 messages
        if (state.messageHistory.length > 50) {
          state.messageHistory = state.messageHistory.slice(-50);
        }

        await saveState(tools, state);

        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "agent.reply",
            payload: { text: reply },
          },
        });

        // Go back to waiting for next event
        return { status: "wait", wakeAt: soonestWakeAt(state.tasks) };
      }

      // ---------------------------------------------------------------
      // Scheduled wake — find due tasks
      // ---------------------------------------------------------------
      case "check": {
        const now = Date.now();
        const due = state.tasks.find((t) => t.enabled && t.nextRun <= now);

        if (!due) {
          // Nothing due — sleep until next task
          return { status: "wait", wakeAt: soonestWakeAt(state.tasks) };
        }

        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "task.starting",
            payload: { taskId: due.id, name: due.name },
          },
        });

        // Continue to execution tick
        return { status: "continue", input: { step: "execute", taskId: due.id, data: null } };
      }

      // ---------------------------------------------------------------
      // Execute the task action (fetch, scrape, etc.)
      // ---------------------------------------------------------------
      case "execute": {
        const task = state.tasks.find((t) => t.id === msg.taskId);
        if (!task) return { status: "continue", input: { step: "check" } };

        let result: string;
        try {
          result = await executeAction(task.action);
        } catch (e: any) {
          return { status: "retry", error: `task ${task.name}: ${e.message}` };
        }

        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "task.executed",
            payload: { taskId: task.id, resultLength: result.length },
          },
        });

        // Continue to delivery tick
        return { status: "continue", input: { step: "deliver", taskId: task.id, result } };
      }

      // ---------------------------------------------------------------
      // Deliver the result (WhatsApp, Slack, etc.)
      // ---------------------------------------------------------------
      case "deliver": {
        const task = state.tasks.find((t) => t.id === msg.taskId);
        if (!task) return { status: "continue", input: { step: "check" } };

        try {
          await deliver(task.deliver, task.name, msg.result);
        } catch (e: any) {
          return { status: "retry", error: `deliver ${task.name}: ${e.message}` };
        }

        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "task.delivered",
            payload: { taskId: task.id, via: task.deliver.type },
          },
        });

        // Continue to schedule tick
        return { status: "continue", input: { step: "schedule", taskId: task.id } };
      }

      // ---------------------------------------------------------------
      // Update lastRun/nextRun, check for more due tasks
      // ---------------------------------------------------------------
      case "schedule": {
        const task = state.tasks.find((t) => t.id === msg.taskId);
        if (task) {
          task.lastRun = Date.now();
          task.nextRun = Date.now() + task.intervalMs;
        }

        await saveState(tools, state);

        // Check if more tasks are due right now
        const now = Date.now();
        const moreDue = state.tasks.find((t) => t.enabled && t.nextRun <= now);
        if (moreDue) {
          return { status: "continue", input: { step: "check" } };
        }

        // All caught up — sleep until next event
        return { status: "wait", wakeAt: soonestWakeAt(state.tasks) };
      }
    }
  },

  endpoints: {},
};

// ---------------------------------------------------------------------------
// Command processor (placeholder for LLM-based intent parsing)
// ---------------------------------------------------------------------------

function processCommand(text: string, state: AgentState): string {
  const lower = text.toLowerCase().trim();

  // --- List tasks ---
  if (lower === "list" || lower === "tasks" || lower === "show tasks") {
    if (state.tasks.length === 0) return "No tasks yet. Try: create task <name> every <interval>";
    return state.tasks
      .map((t) => {
        const status = t.enabled ? "active" : "paused";
        const last = t.lastRun ? new Date(t.lastRun).toISOString() : "never";
        const next = new Date(t.nextRun).toISOString();
        return `[${t.id}] ${t.name} — ${status} — last: ${last} — next: ${next}`;
      })
      .join("\n");
  }

  // --- Create task: "create task <name> every <interval> fetch <url>" ---
  const createMatch = lower.match(/create task (\S+) every (.+?) (fetch|hn_top) (.+)/);
  if (createMatch) {
    const [, name, intervalStr, actionType, actionArg] = createMatch;
    const intervalMs = parseInterval(intervalStr);
    if (!intervalMs) return `Could not parse interval: "${intervalStr}"`;

    const action: TaskAction =
      actionType === "hn_top"
        ? { type: "hn_top", count: parseInt(actionArg) || 10 }
        : { type: "fetch_url", url: actionArg };

    const task: Task = {
      id: nextId(),
      name,
      action,
      intervalMs,
      enabled: true,
      lastRun: null,
      nextRun: Date.now(), // run immediately
      deliver: { type: "event_only" },
    };
    state.tasks.push(task);
    return `Created task ${task.id} "${name}" — runs every ${intervalStr}. Next run: now.`;
  }

  // --- Pause / resume ---
  const toggleMatch = lower.match(/(pause|resume|enable|disable) (\S+)/);
  if (toggleMatch) {
    const [, action, id] = toggleMatch;
    const task = state.tasks.find((t) => t.id === id || t.name === id);
    if (!task) return `Task not found: ${id}`;
    task.enabled = action === "resume" || action === "enable";
    return `Task ${task.name} is now ${task.enabled ? "active" : "paused"}.`;
  }

  // --- Delete ---
  const deleteMatch = lower.match(/(?:delete|remove) (\S+)/);
  if (deleteMatch) {
    const id = deleteMatch[1];
    const idx = state.tasks.findIndex((t) => t.id === id || t.name === id);
    if (idx === -1) return `Task not found: ${id}`;
    const removed = state.tasks.splice(idx, 1)[0];
    return `Deleted task "${removed.name}".`;
  }

  // --- Run now ---
  const runMatch = lower.match(/(?:run|trigger) (\S+)/);
  if (runMatch) {
    const id = runMatch[1];
    const task = state.tasks.find((t) => t.id === id || t.name === id);
    if (!task) return `Task not found: ${id}`;
    task.nextRun = Date.now(); // will be picked up on next check
    task.enabled = true;
    return `Task "${task.name}" will run on the next advance cycle.`;
  }

  // --- Edit interval ---
  const editMatch = lower.match(/edit (\S+) every (.+)/);
  if (editMatch) {
    const [, id, intervalStr] = editMatch;
    const task = state.tasks.find((t) => t.id === id || t.name === id);
    if (!task) return `Task not found: ${id}`;
    const intervalMs = parseInterval(intervalStr);
    if (!intervalMs) return `Could not parse interval: "${intervalStr}"`;
    task.intervalMs = intervalMs;
    task.nextRun = Date.now() + intervalMs;
    return `Task "${task.name}" now runs every ${intervalStr}. Next run: ${new Date(task.nextRun).toISOString()}`;
  }

  // --- Status of a specific task ---
  const statusMatch = lower.match(/(?:status|info|inspect) (\S+)/);
  if (statusMatch) {
    const id = statusMatch[1];
    const task = state.tasks.find((t) => t.id === id || t.name === id);
    if (!task) return `Task not found: ${id}`;
    return [
      `Task: ${task.name} (${task.id})`,
      `Status: ${task.enabled ? "active" : "paused"}`,
      `Action: ${JSON.stringify(task.action)}`,
      `Deliver: ${JSON.stringify(task.deliver)}`,
      `Interval: ${task.intervalMs / 60_000} min`,
      `Last run: ${task.lastRun ? new Date(task.lastRun).toISOString() : "never"}`,
      `Next run: ${new Date(task.nextRun).toISOString()}`,
    ].join("\n");
  }

  return `I don't understand "${text}". Commands: list, create task, pause, resume, delete, run, edit, status`;
}

// ---------------------------------------------------------------------------
// Task execution (replace with real implementations)
// ---------------------------------------------------------------------------

async function executeAction(action: TaskAction): Promise<string> {
  switch (action.type) {
    case "fetch_url": {
      const res = await fetch(action.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      // In real code: extract relevant content, summarize with LLM, etc.
      return body.slice(0, 2000);
    }
    case "hn_top": {
      const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
      if (!res.ok) throw new Error(`HN API ${res.status}`);
      const ids = ((await res.json()) as number[]).slice(0, action.count);
      const items = await Promise.all(
        ids.map(async (id) => {
          const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          return r.ok ? ((await r.json()) as { title: string; url?: string; score: number }) : null;
        }),
      );
      return items
        .filter(Boolean)
        .map((it, i) => `${i + 1}. ${it!.title} (${it!.score} pts)`)
        .join("\n");
    }
    case "custom": {
      return `[custom task: ${action.description}]`;
    }
  }
}

async function deliver(target: DeliverTarget, taskName: string, result: string): Promise<void> {
  switch (target.type) {
    case "whatsapp": {
      // await fetch("https://api.twilio.com/...", {
      //   method: "POST",
      //   body: new URLSearchParams({
      //     From: "whatsapp:+14155238886",
      //     To: `whatsapp:${target.to}`,
      //     Body: `[${taskName}]\n${result}`,
      //   }),
      // });
      break;
    }
    case "slack": {
      // await fetch(target.webhookUrl, {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({ text: `*${taskName}*\n${result}` }),
      // });
      break;
    }
    case "event_only":
      break;
  }
}

// ---------------------------------------------------------------------------
// Storage helper
// ---------------------------------------------------------------------------

async function saveState(tools: any, state: AgentState) {
  const write = await tools({
    name: "ocean.storage.write_scoped",
    input: { ops: [{ op: "run.set", value: state }] },
  });
  if (!write.ok) throw new Error(write.error.message);
}

// ---------------------------------------------------------------------------
// Serverless wiring (pseudo)
// ---------------------------------------------------------------------------

/*
 *   const ocean = createOcean({ db });
 *   ocean.registerClog(taskManagerClog);
 *   await ocean.migrate();
 *
 *   // One-time: create the agent run for a user
 *   POST /agents
 *     const { runId } = await ocean.createRun({
 *       sessionId: req.userId,
 *       clogId: "task_manager",
 *       retry: { maxAttempts: 5 },
 *     });
 *     return json({ runId }, 201);  // status: "idle"
 *
 *   // User sends a message
 *   POST /agents/:runId/messages
 *     const { text } = await req.json();
 *     await ocean.signal(params.runId, { step: "message", text });
 *     await ocean.advance();   // process inline
 *     return json({ ok: true }, 202);
 *
 *   // Read agent replies + task events
 *   GET /agents/:runId/events?after=0
 *     const events = await ocean.readEvents({
 *       scope: { kind: "run", runId: params.runId },
 *       afterSeq: Number(query.after) || 0,
 *     });
 *     return json({ events });
 *
 *   // Inspect agent state
 *   GET /agents/:runId
 *     const info = await ocean.getRun(params.runId);
 *     return json(info);
 *
 *   // ---- Cron (every 1 min) — advance all ready runs ----
 *   scheduled(event, env, ctx) {
 *     while (true) {
 *       const { advanced } = await ocean.advance();
 *       if (advanced === 0) break;
 *     }
 *   }
 *
 * ---
 *
 * Example session:
 *
 *   → signal(runId, { step: "message", text: "create task hn every 6h hn_top 10" })
 *   → advance()  // message tick — creates task, replies, waits until nextRun (now)
 *
 *   → advance()  // check tick — finds hn is due, continues to execute
 *   → advance()  // execute tick — fetches HN top 10, continues to deliver
 *   → advance()  // deliver tick — sends event, continues to schedule
 *   → advance()  // schedule tick — sets nextRun = now+6h, waits
 *
 *   ... 6 hours later, cron calls advance() ...
 *
 *   → advance()  // check tick — hn is due again, continues to execute
 *   → advance()  // execute → deliver → schedule → wait +6h
 *
 *   → signal(runId, { step: "message", text: "pause hn" })
 *   → advance()  // message tick — pauses task, replies, waits (24h default)
 *
 *   → signal(runId, { step: "message", text: "list" })
 *   → advance()  // message tick — lists all tasks with status
 *
 *   → signal(runId, { step: "message", text: "edit hn every 12h" })
 *   → advance()  // message tick — updates interval, replies
 *
 *   → signal(runId, { step: "message", text: "run hn" })
 *   → advance()  // message tick — sets nextRun=now, replies, waits until now
 *   → advance()  // check tick — picks up hn immediately
 *   → advance()  // execute → deliver → schedule → wait +12h
 *
 *   → signal(runId, { step: "message", text: "delete hn" })
 *   → advance()  // message tick — removes task, replies
 *
 *   → signal(runId, { step: "message", text: "status hn" })
 *   → advance()  // message tick — "Task not found: hn"
 */
