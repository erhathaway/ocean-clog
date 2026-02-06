import type { Clog, TickOutcome, AdvanceContext } from "../../ocean/clogs/types.js";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

type QueryInput = { type: "query"; text: string };
type SynthesizeInput = {
  type: "synthesize";
  query: string;
  findings: Array<{ taskId: string; question: string; finding: string }>;
  forceComplete?: boolean;
};
type CoordinatorInput = QueryInput | SynthesizeInput;

export const coordinatorClog: Clog = {
  id: "coordinator",
  endpoints: {},

  async onAdvance(input, ctx): Promise<TickOutcome> {
    const data = input as CoordinatorInput;
    if (!data?.type) return { status: "ok" };

    if (!process.env.OPENAI_API_KEY) {
      return { status: "failed", error: "OPENAI_API_KEY is not set" };
    }

    if (data.type === "query") {
      return await handleQuery(data, ctx);
    }

    if (data.type === "synthesize") {
      return await handleSynthesize(data, ctx);
    }

    return { status: "ok" };
  },
};

async function handleQuery(
  data: QueryInput,
  ctx: AdvanceContext,
): Promise<TickOutcome> {
  const { tools, runId, tickId } = ctx;

  // Read history + current tick row (RBW requirement for writing)
  await tools({
    name: "ocean.storage.read_scoped",
    input: {
      plans: [
        { kind: "history_ticks_for_run", runId, rowIds: ["exchange"], order: "asc" },
        { kind: "tick_rows", runId, tickId, rowIds: ["exchange"] },
      ],
    },
  });

  await tools({
    name: "ocean.events.emit",
    input: {
      scope: { kind: "global" },
      type: "research.status",
      payload: { message: "Decomposing query into research tasks..." },
    },
  });

  const systemPrompt = `You are a research coordinator. Given a query, decompose it into 2-4 focused sub-tasks that together will answer the query comprehensively. Each sub-task should be a specific, answerable research question.

Respond with ONLY a JSON array of objects with "id" and "question" fields. Example:
[{"id": "task-1", "question": "What is X?"}, {"id": "task-2", "question": "How does Y work?"}]`;

  const result = await generateText({
    model: openai("gpt-5-nano"),
    system: systemPrompt,
    prompt: data.text,
  });

  let tasks: Array<{ id: string; question: string }>;
  try {
    tasks = JSON.parse(result.text);
  } catch {
    return { status: "retry", error: "Failed to parse task decomposition" };
  }

  // Store LLM exchange in tick storage
  await tools({
    name: "ocean.storage.write_scoped",
    input: {
      ops: [
        {
          op: "tick.set",
          runId,
          tickId,
          rowId: "exchange",
          value: {
            role: "coordinator",
            action: "decompose",
            system: systemPrompt,
            prompt: data.text,
            response: result.text,
            parsedTasks: tasks,
          },
        },
      ],
    },
  });

  await tools({
    name: "ocean.events.emit",
    input: {
      scope: { kind: "global" },
      type: "research.plan",
      payload: { tasks },
    },
  });

  return { status: "ok" };
}

async function handleSynthesize(
  data: SynthesizeInput,
  ctx: AdvanceContext,
): Promise<TickOutcome> {
  const { tools, runId, tickId } = ctx;

  // Read history + current tick row (RBW requirement for writing)
  await tools({
    name: "ocean.storage.read_scoped",
    input: {
      plans: [
        { kind: "history_ticks_for_run", runId, rowIds: ["exchange"], order: "asc" },
        { kind: "tick_rows", runId, tickId, rowIds: ["exchange"] },
      ],
    },
  });

  await tools({
    name: "ocean.events.emit",
    input: {
      scope: { kind: "global" },
      type: "research.status",
      payload: { message: "Synthesizing findings..." },
    },
  });

  const findingsSummary = data.findings
    .map((f) => `### ${f.question}\n${f.finding}`)
    .join("\n\n");

  const systemPrompt = data.forceComplete
    ? `You are a research coordinator. Synthesize the findings below into a comprehensive answer to the original query. Respond with ONLY a JSON object: {"complete": true, "summary": "your synthesis here"}`
    : `You are a research coordinator. Analyze the findings below and decide:
1. If the findings sufficiently answer the query, respond with: {"complete": true, "summary": "your synthesis here"}
2. If some areas need deeper investigation, respond with: {"complete": false, "followups": [{"taskId": "task-1", "direction": "specific direction for deeper research"}]}

Respond with ONLY the JSON object.`;

  const userPrompt = `Original query: ${data.query}\n\nFindings:\n${findingsSummary}`;

  const result = await generateText({
    model: openai("gpt-5-nano"),
    system: systemPrompt,
    prompt: userPrompt,
  });

  let decision: any;
  try {
    decision = JSON.parse(result.text);
  } catch {
    return { status: "retry", error: "Failed to parse synthesis decision" };
  }

  // Store LLM exchange in tick storage
  await tools({
    name: "ocean.storage.write_scoped",
    input: {
      ops: [
        {
          op: "tick.set",
          runId,
          tickId,
          rowId: "exchange",
          value: {
            role: "coordinator",
            action: "synthesize",
            system: systemPrompt,
            prompt: userPrompt,
            response: result.text,
            decision,
          },
        },
      ],
    },
  });

  if (decision.complete) {
    await tools({
      name: "ocean.events.emit",
      input: {
        scope: { kind: "global" },
        type: "research.complete",
        payload: { summary: decision.summary },
      },
    });
  } else {
    await tools({
      name: "ocean.events.emit",
      input: {
        scope: { kind: "global" },
        type: "research.status",
        payload: {
          message: `Requesting ${decision.followups.length} follow-up investigation(s)...`,
        },
      },
    });

    for (const followup of decision.followups) {
      await tools({
        name: "ocean.events.emit",
        input: {
          scope: { kind: "global" },
          type: "research.followup",
          payload: { taskId: followup.taskId, direction: followup.direction },
        },
      });
    }
  }

  return { status: "ok" };
}
