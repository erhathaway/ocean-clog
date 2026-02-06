import { createOcean, createLibsqlDb } from "../../ocean/index.js";
import { coordinatorClog } from "./coordinator.js";
import { researcherClog } from "./researcher.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";

// Load .env if OPENAI_API_KEY not already set
if (!process.env.OPENAI_API_KEY) {
  const envPath = new URL(".env", import.meta.url).pathname;
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY is required. Set it in your environment or in examples/research/.env",
  );
  process.exit(1);
}

// --- types ---

const SESSION_FILE = ".research-session";
const DB_FILE = "research.db";
const MAX_ROUNDS = 3;

type Task = {
  id: string;
  question: string;
  runId: string;
  finding?: string;
  done: boolean;
};

type Session = {
  coordinatorRunId: string;
  query: string;
  tasks: Task[];
  lastSeq: number;
  round: number;
  done: boolean;
};

function loadSession(): Session | null {
  if (!existsSync(SESSION_FILE)) return null;
  return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
}

function saveSession(session: Session): void {
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

function resetState(): void {
  for (const f of [SESSION_FILE, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

// --- helpers ---

function log(prefix: string, message: string): void {
  console.log(`\x1b[36m[${prefix}]\x1b[0m ${message}`);
}

function createOceanInstance() {
  const { db } = createLibsqlDb({ url: `file:./${DB_FILE}` });
  return createOcean({ db });
}

// --- determine if we need a fresh start (before opening DB) ---

const query = process.argv.slice(2).join(" ");
let session = loadSession();

if (query) {
  // Decide whether to start fresh before we open the DB
  if (session) {
    if (session.done) {
      log("info", `Previous research on "${session.query}" is complete. Starting fresh.`);
      resetState();
      session = null;
    } else if (session.query !== query) {
      log("info", `Different query. Previous: "${session.query}". Starting fresh.`);
      resetState();
      session = null;
    }
  }
}

// --- now open DB (after any reset) ---

const ocean = createOceanInstance();
ocean.registerClog(coordinatorClog);
ocean.registerClog(researcherClog);
await ocean.migrate();

// --- status check (no query arg) ---

if (!query) {
  if (!session) {
    console.error("Usage: bun research.ts <query>");
    console.error("       bun research.ts          (check status of current research)");
    process.exit(1);
  }

  const run = await ocean.getRun(session.coordinatorRunId);
  if (!run) {
    log("status", "Previous research session not found in database. Run a new query to start fresh.");
    process.exit(1);
  }

  log("query", session.query);
  log("status", `Coordinator: ${run.status}`);
  log("status", `Round: ${session.round}/${MAX_ROUNDS}`);
  log("status", `Tasks: ${session.tasks.length} (${session.tasks.filter((t) => t.done).length} completed)`);

  if (session.done) {
    const events = await ocean.readEvents({
      scope: { kind: "global" },
      afterSeq: 0,
    });
    const complete = events.find((e) => e.type === "research.complete");
    if (complete) {
      console.log();
      log("complete", "Research complete!\n");
      console.log((complete.payload as any).summary);
    }
  } else {
    for (const task of session.tasks) {
      const status = task.done ? "\x1b[32mdone\x1b[0m" : "\x1b[33mpending\x1b[0m";
      log("task", `  ${task.id} [${status}]: ${task.question}`);
    }
  }

  process.exit(0);
}

// --- validate resume or start fresh ---

if (session) {
  const run = await ocean.getRun(session.coordinatorRunId);
  if (!run || run.status === "failed") {
    log("info", "Previous research failed or not found. Starting fresh.");
    session = null;
    // DB is already open and clean (tables exist), just need a new session
  } else {
    log("info", `Resuming research on "${query}" (round ${session.round})`);
  }
}

if (!session) {
  const { runId: coordinatorRunId } = await ocean.createRun({
    sessionId: "research",
    clogId: "coordinator",
  });

  session = {
    coordinatorRunId,
    query,
    tasks: [],
    lastSeq: 0,
    round: 0,
    done: false,
  };

  log("start", `Research query: "${query}"`);
  await ocean.signal(session.coordinatorRunId, { type: "query", text: query });
  saveSession(session);
}

// --- advance helper ---

async function advanceAll(): Promise<void> {
  while (true) {
    const { advanced, results } = await ocean.advance();
    if (advanced === 0) break;
    for (const r of results) {
      if (r.outcome === "retry" || r.outcome === "failed") {
        const run = await ocean.getRun(r.runId);
        log("advance", `${r.runId.slice(0, 12)}… → ${r.outcome}: ${run?.lastError}`);
      } else {
        log("advance", `${r.runId.slice(0, 12)}… → ${r.outcome}`);
      }
    }
  }
}

// --- main loop ---

while (!session.done) {
  await advanceAll();

  const events = await ocean.readEvents({
    scope: { kind: "global" },
    afterSeq: session.lastSeq,
  });

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    session.lastSeq = evt.seq;
    const payload = evt.payload as any;

    switch (evt.type) {
      case "research.status": {
        log("status", payload.message);
        break;
      }

      case "research.plan": {
        log("plan", `${payload.tasks.length} research tasks:`);
        for (const task of payload.tasks) {
          log("task", `  ${task.id}: ${task.question}`);

          const { runId } = await ocean.createRun({
            sessionId: "research",
            clogId: "researcher",
          });
          await ocean.signal(runId, {
            taskId: task.id,
            question: task.question,
          });

          session.tasks.push({
            id: task.id,
            question: task.question,
            runId,
            done: false,
          });
        }
        await advanceAll();

        const newEvents = await ocean.readEvents({
          scope: { kind: "global" },
          afterSeq: session.lastSeq,
        });
        events.push(...newEvents);
        break;
      }

      case "research.finding": {
        const task = session.tasks.find((t) => t.id === payload.taskId);
        if (task) {
          task.finding = payload.finding;
          task.done = true;
          log(
            "finding",
            `${payload.taskId}: ${payload.finding.slice(0, 120)}...`,
          );
        }
        break;
      }

      case "research.followup": {
        const task = session.tasks.find((t) => t.id === payload.taskId);
        if (task) {
          log("followup", `${payload.taskId}: ${payload.direction}`);
          task.done = false;
          await ocean.signal(task.runId, {
            taskId: task.id,
            question: task.question,
            direction: payload.direction,
            previousFinding: task.finding,
          });
        }
        break;
      }

      case "research.complete": {
        console.log();
        log("complete", "Research complete!\n");
        console.log(payload.summary);
        session.done = true;
        break;
      }
    }
  }

  saveSession(session);

  // If all tasks are done and we haven't finished, synthesize
  if (!session.done && session.tasks.length > 0 && session.tasks.every((t) => t.done)) {
    await advanceAll();
    const lateEvents = await ocean.readEvents({
      scope: { kind: "global" },
      afterSeq: session.lastSeq,
    });
    for (const evt of lateEvents) {
      session.lastSeq = evt.seq;
      const payload = evt.payload as any;
      if (evt.type === "research.finding") {
        const task = session.tasks.find((t) => t.id === payload.taskId);
        if (task) {
          task.finding = payload.finding;
          task.done = true;
          log(
            "finding",
            `${payload.taskId}: ${payload.finding.slice(0, 120)}...`,
          );
        }
      }
    }

    session.round++;
    const forceComplete = session.round >= MAX_ROUNDS;
    if (forceComplete) {
      log("status", `Max rounds (${MAX_ROUNDS}) reached, forcing synthesis.`);
    }

    const findings = session.tasks
      .filter((t) => t.finding)
      .map((t) => ({
        taskId: t.id,
        question: t.question,
        finding: t.finding!,
      }));

    await ocean.signal(session.coordinatorRunId, {
      type: "synthesize",
      query,
      findings,
      forceComplete,
    });

    saveSession(session);
  }
}

saveSession(session);
