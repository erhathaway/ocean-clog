import type { Clog, TickOutcome } from "../../ocean/clogs/types.js";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

type ResearchInput = {
  taskId: string;
  question: string;
  direction?: string;
  previousFinding?: string;
};

export const researcherClog: Clog = {
  id: "researcher",
  endpoints: {},

  async onAdvance(input, { tools, runId, tickId }): Promise<TickOutcome> {
    const data = input as ResearchInput;
    if (!data?.taskId || !data?.question) return { status: "ok" };

    if (!process.env.OPENAI_API_KEY) {
      return { status: "failed", error: "OPENAI_API_KEY is not set" };
    }

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

    const systemPrompt =
      "You are a thorough research assistant. Provide detailed, factual findings for the given research question. Focus on concrete facts, recent developments, and key details. Be comprehensive but concise.";

    let prompt: string;
    if (data.direction && data.previousFinding) {
      prompt = `Previous research on "${data.question}":\n${data.previousFinding}\n\nFollow-up direction: ${data.direction}\n\nProvide additional findings based on this direction.`;
    } else {
      prompt = data.question;
    }

    const result = await generateText({
      model: openai("gpt-5-nano"),
      system: systemPrompt,
      prompt,
    });

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
              role: "researcher",
              taskId: data.taskId,
              system: systemPrompt,
              prompt,
              response: result.text,
            },
          },
        ],
      },
    });

    await tools({
      name: "ocean.events.emit",
      input: {
        scope: { kind: "global" },
        type: "research.finding",
        payload: {
          taskId: data.taskId,
          question: data.question,
          finding: result.text,
        },
      },
    });

    return { status: "ok" };
  },
};
