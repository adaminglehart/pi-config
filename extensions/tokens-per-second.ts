import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "token-rate";
const WINDOW_MS = 1500;
const UPDATE_INTERVAL_MS = 120;
// Live rate is estimated from streamed characters; final rate uses provider usage.
const CHARS_PER_TOKEN = 4;
const IDLE_STATUS = "- t/s ░░░░░ · idle";

interface Sample {
  time: number;
  chars: number;
}

/** Timing for the assistant message that is streaming now. */
interface MessageTiming {
  requestStart: number;
  firstDelta: number;
  chars: number;
  thinkingChars: number;
}

/** Totals for all assistant messages in one agent run. */
interface RunTotals {
  outputTokens: number;
  generationMs: number;
  lastTtftMs: number;
  estimated: boolean;
}

function bar(tps: number, max = 150): string {
  const width = 5;
  const n = Math.min(Math.round((tps / max) * width), width);
  return "▓".repeat(n) + "░".repeat(width - n);
}

function rate(tokens: number, ms: number): number {
  return ms > 100 ? Math.round(tokens / (ms / 1000)) : 0;
}

export default function (pi: ExtensionAPI) {
  let requestStart = 0;
  let message: MessageTiming | null = null;
  let samples: Sample[] = [];
  let lastUpdate = 0;
  let run: RunTotals = { outputTokens: 0, generationMs: 0, lastTtftMs: 0, estimated: false };

  function setStatus(ctx: ExtensionContext, text: string): void {
    ctx.ui.setStatus(STATUS_ID, text);
  }

  function liveStatus(now: number): string {
    samples = samples.filter((s) => now - s.time < WINDOW_MS);
    const windowChars = samples.reduce((sum, s) => sum + s.chars, 0);
    if (!message || message.firstDelta === 0) return `0 t/s ${bar(0)} · warming...`;
    // Early in a message the window holds less than WINDOW_MS of samples.
    const spanMs = Math.max(250, Math.min(WINDOW_MS, now - message.firstDelta));
    const instant = rate(windowChars / CHARS_PER_TOKEN, spanMs);
    const ttft = (message.firstDelta - message.requestStart) / 1000;
    const avg = rate(message.chars / CHARS_PER_TOKEN, now - message.firstDelta);
    return `${instant} t/s ${bar(instant)} · TTFT ${ttft.toFixed(1)}s · avg ${avg}`;
  }

  function finalStatus(): string {
    if (run.generationMs === 0) return IDLE_STATUS;
    const approx = run.estimated ? "~" : "";
    const tps = rate(run.outputTokens, run.generationMs);
    return `${approx}${tps} t/s · TTFT ${(run.lastTtftMs / 1000).toFixed(2)}s`;
  }

  pi.on("session_start", async (_event, ctx) => {
    setStatus(ctx, IDLE_STATUS);
  });

  pi.on("agent_start", async (_event, ctx) => {
    run = { outputTokens: 0, generationMs: 0, lastTtftMs: 0, estimated: false };
    message = null;
    setStatus(ctx, "0 t/s ░░░░░ · warming");
  });

  // Time to first token starts when the request goes to the provider,
  // so context building and tool execution are not counted.
  pi.on("before_provider_request", async () => {
    requestStart = Date.now();
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    message = { requestStart: requestStart || Date.now(), firstDelta: 0, chars: 0, thinkingChars: 0 };
    samples = [];
    lastUpdate = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    if (!message) return;
    const ev = event.assistantMessageEvent;
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;

    const now = Date.now();
    if (message.firstDelta === 0) message.firstDelta = now;
    message.chars += ev.delta.length;
    if (ev.type === "thinking_delta") message.thinkingChars += ev.delta.length;
    samples.push({ time: now, chars: ev.delta.length });

    if (now - lastUpdate > UPDATE_INTERVAL_MS) {
      lastUpdate = now;
      setStatus(ctx, liveStatus(now));
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || !message) return;
    const current = message;
    message = null;
    requestStart = 0;
    if (current.firstDelta === 0) return;

    // Hidden reasoning tokens are generated before the first visible delta,
    // so they are not part of the measured generation time.
    const { output, reasoning } = event.message.usage;
    const hiddenReasoning = current.thinkingChars === 0 ? (reasoning ?? 0) : 0;
    const reported = output - hiddenReasoning;
    run.outputTokens += reported > 0 ? reported : Math.round(current.chars / CHARS_PER_TOKEN);
    run.estimated ||= reported <= 0;
    run.generationMs += Date.now() - current.firstDelta;
    run.lastTtftMs = current.firstDelta - current.requestStart;
  });

  pi.on("agent_end", async (_event, ctx) => {
    message = null;
    setStatus(ctx, finalStatus());
  });
}
