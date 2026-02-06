import { createOcean, createLibsqlDb } from "../../ocean/index.js";
import { coordinatorClog } from "./coordinator.js";
import { researcherClog } from "./researcher.js";
import { readFileSync, existsSync } from "fs";

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

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: bun research.ts <query>");
  process.exit(1);
}

const MAX_ROUNDS = 3;

type Task = {
  id: string;
  question: string;
  runId: string;
  finding?: string;
  done: boolean;
};

// --- setup ---

const { db } = createLibsqlDb({ url: "file:./research.db" });
const ocean = createOcean({ db });
ocean.registerClog(coordinatorClog);
ocean.registerClog(researcherClog);
await ocean.migrate();

// --- helpers ---

async function advanceAll(): Promise<void> {
  while (true) {
    const { advanced } = await ocean.advance();
    if (advanced === 0) break;
  }
}

function log(prefix: string, message: string): void {
  console.log(`\x1b[36m[${prefix}]\x1b[0m ${message}`);
}

// --- main loop ---

const { runId: coordinatorRunId } = await ocean.createRun({
  sessionId: "research",
  clogId: "coordinator",
});

log("start", `Research query: "${query}"`);
await ocean.signal(coordinatorRunId, { type: "query", text: query });

let tasks: Task[] = [];
let lastSeq = 0;
let round = 0;
let done = false;

while (!done) {
  await advanceAll();

  const events = await ocean.readEvents({
    scope: { kind: "global" },
    afterSeq: lastSeq,
  });

  // Index-based loop: handlers may push new events onto the array
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    lastSeq = evt.seq;
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

          tasks.push({
            id: task.id,
            question: task.question,
            runId,
            done: false,
          });
        }
        // Advance the newly created researcher runs
        await advanceAll();

        // Append any new events (e.g. findings) for processing
        const newEvents = await ocean.readEvents({
          scope: { kind: "global" },
          afterSeq: lastSeq,
        });
        events.push(...newEvents);
        break;
      }

      case "research.finding": {
        const task = tasks.find((t) => t.id === payload.taskId);
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
        const task = tasks.find((t) => t.id === payload.taskId);
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
        done = true;
        break;
      }
    }
  }

  // If all tasks are done and we haven't finished, synthesize
  if (!done && tasks.length > 0 && tasks.every((t) => t.done)) {
    // After followups, re-advance researchers and re-read
    await advanceAll();
    const lateEvents = await ocean.readEvents({
      scope: { kind: "global" },
      afterSeq: lastSeq,
    });
    for (const evt of lateEvents) {
      lastSeq = evt.seq;
      const payload = evt.payload as any;
      if (evt.type === "research.finding") {
        const task = tasks.find((t) => t.id === payload.taskId);
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

    round++;
    const forceComplete = round >= MAX_ROUNDS;
    if (forceComplete) {
      log("status", `Max rounds (${MAX_ROUNDS}) reached, forcing synthesis.`);
    }

    const findings = tasks
      .filter((t) => t.finding)
      .map((t) => ({
        taskId: t.id,
        question: t.question,
        finding: t.finding!,
      }));

    await ocean.signal(coordinatorRunId, {
      type: "synthesize",
      query,
      findings,
      forceComplete,
    });
  }
}
