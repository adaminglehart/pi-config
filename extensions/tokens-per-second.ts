import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TpsMetrics {
  elapsedSec: number;
  ttftSec: number;
  avgTps: number;
  instantTps: number;
  hasTokens: boolean;
}

export default function (pi: ExtensionAPI) {
  let tokenCount = 0;
  let startTime = 0;
  let firstTokenTime = 0;
  let lastUpdate = 0;
  let streaming = false;
  let recentDeltas: number[] = []; // timestamps for sliding window

  const WINDOW_MS = 1500;

  function bar(tps: number, max = 150): string {
    const width = 5;
    const n = Math.min(Math.round((tps / max) * width), width);
    return "▓".repeat(n) + "░".repeat(width - n);
  }

  function calculateMetrics(now: number): TpsMetrics {
    // Prune old deltas and calculate instant TPS
    recentDeltas = recentDeltas.filter((t) => now - t < WINDOW_MS);
    const instantTps = Math.round(recentDeltas.length / (WINDOW_MS / 1000));

    // Calculate timing metrics
    const elapsedMs = now - startTime;
    const elapsedSec = elapsedMs / 1000;
    const ttftMs = firstTokenTime > startTime ? firstTokenTime - startTime : 0;
    const ttftSec = ttftMs / 1000;

    // Calculate average TPS
    const avgTps = elapsedSec > 0.1 ? Math.round(tokenCount / elapsedSec) : 0;

    return {
      elapsedSec,
      ttftSec,
      avgTps,
      instantTps,
      hasTokens: firstTokenTime > startTime,
    };
  }

  function formatStreamingStatus(m: TpsMetrics): string {
    const barStr = bar(m.instantTps);

    if (m.hasTokens) {
      return `${m.instantTps} t/s ${barStr} · TTFT ${m.ttftSec.toFixed(1)}s · avg ${m.avgTps}`;
    }
    return `${m.instantTps} t/s ${barStr} · warming...`;
  }

  function formatFinalStatus(m: TpsMetrics): string {
    return `${m.avgTps} t/s · TTFT ${m.ttftSec.toFixed(2)}s`;
  }

  function updateStatus(ctx: {
    ui: { setStatus: (id: string, status: string) => void };
  }) {
    const m = calculateMetrics(Date.now());
    ctx.ui.setStatus("token-rate", formatStreamingStatus(m));
  }

  // Set idle on session start and re-set it before each turn until streaming begins
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("token-rate", "- t/s ░░░░░ · idle");
  });

  pi.on("turn_start", async (_event, ctx) => {
    // Re-assert idle status if we're not yet streaming (ensures consistent footer width)
    if (!streaming) {
      ctx.ui.setStatus("token-rate", "- t/s ░░░░░ · idle");
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    tokenCount = 0;
    startTime = Date.now();
    firstTokenTime = 0;
    lastUpdate = 0;
    recentDeltas = [];
    streaming = true;
    ctx.ui.setStatus("token-rate", "0 t/s ░░░░░ · warming");
  });

  pi.on("message_update", async (event, ctx) => {
    if (!streaming) return;

    const ev = event.assistantMessageEvent;
    if (ev.type === "text_delta" || ev.type === "thinking_delta") {
      const now = Date.now();

      // Record first token time
      if (firstTokenTime === 0) {
        firstTokenTime = now;
      }

      tokenCount++;
      recentDeltas.push(now);

      // Update every 120ms max to avoid flicker
      if (now - lastUpdate > 120) {
        lastUpdate = now;
        updateStatus(ctx);
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    streaming = false;
    const m = calculateMetrics(Date.now());
    ctx.ui.setStatus("token-rate", formatFinalStatus(m));
  });
}
