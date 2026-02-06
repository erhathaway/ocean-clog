import type { Clog, TickOutcome } from "../../ocean/clogs/types.js";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

type Message = { role: "user" | "assistant"; content: string };

export const chatClog: Clog = {
  id: "chat",
  endpoints: {},

  async onAdvance(input, { tools }): Promise<TickOutcome> {
    const { messages } = (input as any) ?? {};
    if (!messages?.length) return { status: "ok" };

    if (!process.env.OPENAI_API_KEY) {
      return { status: "failed", error: "OPENAI_API_KEY is not set" };
    }

    // Call GPT-5 Nano with full conversation history
    const result = await generateText({
      model: openai("gpt-5-nano"),
      messages: messages as Message[],
    });

    const reply = result.text;

    // Emit event with the reply
    await tools({
      name: "ocean.events.emit",
      input: {
        scope: { kind: "global" },
        type: "chat.response",
        payload: { text: reply },
      },
    });

    return { status: "ok" };
  },
};
