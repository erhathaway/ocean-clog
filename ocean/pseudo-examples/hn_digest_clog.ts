/**
 * HackerNews digest clog — periodic scrape → filter → notify via WhatsApp
 *
 * Each check is broken into three ticks (advance() calls) chained via "continue":
 *
 *   Tick 1  "fetch"     — hit the HN API, pull top story IDs
 *   Tick 2  "summarize" — fetch details for each story, build a digest
 *   Tick 3  "notify"    — send the digest over WhatsApp
 *
 * After notifying, the run returns "wait" with a wakeAt 8 hours in the future.
 * When wakeAt arrives, advance() picks it up and the cycle repeats.
 *
 * If any step fails (network error, rate limit), it returns "retry" and
 * exponential backoff kicks in automatically (up to max_attempts).
 *
 * Setup:
 *   const { runId } = await ocean.createRun({
 *     sessionId: "user_123",
 *     clogId: "hn_digest",
 *     input: { step: "fetch" },             // kick off immediately
 *     retry: { maxAttempts: 5 },
 *   });
 *
 * Then just call advance() on a schedule (cron, Durable Object alarm, etc.)
 */

import type { Clog, TickOutcome } from "../clogs/types.js";

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const HN_TOP_STORIES = "https://hacker-news.firebaseio.com/v0/topstories.json";
const hnItem = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

type Step =
  | { step: "fetch" }
  | { step: "summarize"; storyIds: number[] }
  | { step: "notify"; digest: string };

type HNItem = { id: number; title: string; url?: string; score: number; by: string };

export const hnDigestClog: Clog = {
  id: "hn_digest",

  async onAdvance(input, { tools, attempt }): Promise<TickOutcome> {
    const msg = (input ?? { step: "fetch" }) as Step;

    switch (msg.step) {
      // -----------------------------------------------------------------
      // Tick 1: Fetch top story IDs from HN
      // -----------------------------------------------------------------
      case "fetch": {
        let storyIds: number[];
        try {
          const res = await fetch(HN_TOP_STORIES);
          if (!res.ok) return { status: "retry", error: `HN API ${res.status}` };
          storyIds = ((await res.json()) as number[]).slice(0, 15);
        } catch (e: any) {
          return { status: "retry", error: e.message };
        }

        // Emit progress event
        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "digest.progress",
            payload: { step: "fetch", count: storyIds.length },
          },
        });

        // Continue to next tick with the IDs
        return { status: "continue", input: { step: "summarize", storyIds } };
      }

      // -----------------------------------------------------------------
      // Tick 2: Fetch details for each story and build a digest string
      // -----------------------------------------------------------------
      case "summarize": {
        const items: HNItem[] = [];
        try {
          const fetches = msg.storyIds.map(async (id) => {
            const res = await fetch(hnItem(id));
            if (!res.ok) return null;
            return (await res.json()) as HNItem;
          });
          const results = await Promise.all(fetches);
          for (const item of results) {
            if (item) items.push(item);
          }
        } catch (e: any) {
          return { status: "retry", error: e.message };
        }

        const lines = items.map(
          (it, i) => `${i + 1}. ${it.title} (${it.score} pts) — ${it.url ?? `https://news.ycombinator.com/item?id=${it.id}`}`,
        );
        const digest = `*HN Digest*\n\n${lines.join("\n")}`;

        // Persist the digest in run storage so we have history
        const read = await tools({
          name: "ocean.storage.read_scoped",
          input: { plans: [{ kind: "run" }] },
        });
        if (!read.ok) return { status: "retry", error: read.error.message };

        const state = ((read.output as any).snapshot?.[0]?.value ?? { digests: [] }) as {
          digests: Array<{ ts: number; digest: string }>;
        };
        state.digests.push({ ts: Date.now(), digest });

        // Keep only last 10 digests
        if (state.digests.length > 10) state.digests = state.digests.slice(-10);

        const write = await tools({
          name: "ocean.storage.write_scoped",
          input: { ops: [{ op: "run.set", value: state }] },
        });
        if (!write.ok) return { status: "retry", error: write.error.message };

        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "digest.progress",
            payload: { step: "summarize", stories: items.length },
          },
        });

        return { status: "continue", input: { step: "notify", digest } };
      }

      // -----------------------------------------------------------------
      // Tick 3: Send WhatsApp message, then sleep until next check
      // -----------------------------------------------------------------
      case "notify": {
        try {
          // --- Send WhatsApp via Twilio (pseudo) ---
          // await fetch("https://api.twilio.com/2010-04-01/Accounts/.../Messages.json", {
          //   method: "POST",
          //   headers: { Authorization: `Basic ${btoa(TWILIO_SID + ":" + TWILIO_TOKEN)}` },
          //   body: new URLSearchParams({
          //     From: "whatsapp:+14155238886",
          //     To:   "whatsapp:+1XXXXXXXXXX",
          //     Body: msg.digest,
          //   }),
          // });
          void msg.digest; // placeholder — use msg.digest as the message body
        } catch (e: any) {
          return { status: "retry", error: e.message };
        }

        await tools({
          name: "ocean.events.emit",
          input: {
            scope: { kind: "run" },
            type: "digest.sent",
            payload: { ts: Date.now() },
          },
        });

        // Done for now — wake up in 8 hours to do it again
        return { status: "wait", wakeAt: Date.now() + EIGHT_HOURS_MS };
      }
    }
  },

  endpoints: {},
};

// ---------------------------------------------------------------------------
// Serverless setup (pseudo)
// ---------------------------------------------------------------------------

/*
 *   const ocean = createOcean({ db });
 *   ocean.registerClog(hnDigestClog);
 *   await ocean.migrate();
 *
 *   // Create a run for each user who subscribes:
 *   POST /subscribe
 *     const { runId } = await ocean.createRun({
 *       sessionId: req.userId,
 *       clogId: "hn_digest",
 *       input: { step: "fetch" },       // starts immediately
 *       retry: { maxAttempts: 5 },
 *     });
 *     return json({ runId }, 201);
 *
 *   // Cron job (every 5 minutes) drains all ready runs:
 *   scheduled(event, env, ctx) {
 *     while (true) {
 *       const { advanced } = await ocean.advance();
 *       if (advanced === 0) break;
 *     }
 *   }
 *
 *   // One advance() call processes one tick for one run.
 *   // For the HN digest, a full cycle takes 3 advance() calls:
 *   //
 *   //   advance() → fetch    → continue → status: pending
 *   //   advance() → summarize → continue → status: pending
 *   //   advance() → notify   → wait     → status: waiting, wake_at: +8h
 *   //   ... 8 hours later ...
 *   //   advance() → fetch    → continue → ...
 *   //
 *   // If fetch fails on attempt 0:
 *   //   advance() → fetch → retry → status: pending, wake_at: +2s, attempt: 1
 *   //   advance() (after 2s) → fetch → retry → wake_at: +4s, attempt: 2
 *   //   advance() (after 4s) → fetch → ok → resets attempt to 0, continues
 *   //   ... or after 5 failures → status: "failed"
 */
