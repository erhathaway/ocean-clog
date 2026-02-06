import { createOcean, createLibsqlDb } from "../../ocean/index.js";
import { chatClog } from "./clog.js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const SESSION_FILE = ".chat-session";

type Message = { role: "user" | "assistant"; content: string };
type Session = { runId: string; lastSeq: number; messages: Message[] };

function loadSession(): Session | null {
  if (!existsSync(SESSION_FILE)) return null;
  return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
}

function saveSession(session: Session): void {
  writeFileSync(SESSION_FILE, JSON.stringify(session));
}

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

// --- main ---

const message = process.argv.slice(2).join(" ");
if (!message) {
  console.error("Usage: bun chat.ts <message>");
  process.exit(1);
}

// 1. Create DB + Ocean
const { db } = createLibsqlDb({ url: "file:./chat.db" });
const ocean = createOcean({ db });
ocean.registerClog(chatClog);
await ocean.migrate();

// 2. Load or create session (reset if previous run is terminal)
let session = loadSession();
if (session) {
  const run = await ocean.getRun(session.runId);
  if (!run || run.status === "failed" || run.status === "done") {
    session = null;
  }
}
if (!session) {
  const { runId } = await ocean.createRun({
    sessionId: "cli",
    clogId: "chat",
  });
  session = { runId, lastSeq: 0, messages: [] };
}

// 3. Append user message and signal with full history
session.messages.push({ role: "user", content: message });
await ocean.signal(session.runId, { messages: session.messages });

// 4. Advance — runs the clog
const { results } = await ocean.advance();

// Check for errors
const result = results[0];
if (result?.outcome === "failed") {
  const run = await ocean.getRun(session.runId);
  console.error(run?.lastError ?? "advance failed");
  session.messages.pop(); // remove the user message we just added
  saveSession(session);
  process.exit(1);
}

// 5. Read new events
const events = await ocean.readEvents({
  scope: { kind: "global" },
  afterSeq: session.lastSeq,
});

// 6. Print responses, append to history, track seq
for (const evt of events) {
  if (evt.type === "chat.response") {
    const text = (evt.payload as any).text;
    console.log(text);
    session.messages.push({ role: "assistant", content: text });
  }
  session.lastSeq = evt.seq;
}

// 7. Save session
saveSession(session);
