import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let startTimestamp: number | null = null;
  let firstTokenTimestamp: number | null = null;
  let finalStatsSet = false;

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") {
      startTimestamp = event.message.timestamp;
      firstTokenTimestamp = null;
      finalStatsSet = false;
      // Clear any previous stats when starting a new message
      ctx.ui.setStatus("tps", undefined);
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // Record timestamp of first token
    if (
      firstTokenTimestamp === null &&
      (event.assistantMessageEvent.type === "text_delta" ||
        event.assistantMessageEvent.type === "thinking_delta")
    ) {
      firstTokenTimestamp = Date.now();
    }

    // Estimate tokens from content length since usage.output is 0 during streaming
    let estimatedTokens = 0;
    for (const item of event.message.content) {
      if (item.type === "text" && item.text) {
        // Rough estimate: ~4 chars per token
        estimatedTokens += Math.floor(item.text.length / 4);
      }
    }

    if (firstTokenTimestamp && estimatedTokens > 0 && !finalStatsSet) {
      const elapsed = (Date.now() - firstTokenTimestamp) / 1000;
      const tokensPerSecond = elapsed > 0 ? (estimatedTokens / elapsed).toFixed(1) : "0.0";
      ctx.ui.setStatus("tps", `${tokensPerSecond} tok/s`);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // Use actual token count from usage
    const finalTokens = event.message.usage.output;

    // Calculate final stats
    if (startTimestamp && firstTokenTimestamp && finalTokens > 0) {
      const endTime = Date.now();
      const generationElapsed = (endTime - firstTokenTimestamp) / 1000;
      const timeToFirstToken = (firstTokenTimestamp - startTimestamp) / 1000;
      const avgTokensPerSecond = generationElapsed > 0 ? (finalTokens / generationElapsed).toFixed(1) : "0.0";

      const finalStatus = `${avgTokensPerSecond} tok/s (TTFT: ${timeToFirstToken.toFixed(2)}s)`;
      
      // Show final stats and mark that we've set them
      ctx.ui.setStatus("tps", finalStatus);
      finalStatsSet = true;
    }

    // Reset for next message
    startTimestamp = null;
    firstTokenTimestamp = null;
  });

  // Don't clear on other events - let the final stats persist
}
