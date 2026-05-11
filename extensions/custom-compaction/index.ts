import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { getNamespacedConfig } from "../_lib/settings.js";

interface CompactionModelConfig {
  provider: string;
  model: string;
}

function readCompactionSettings(): CompactionModelConfig {
  return getNamespacedConfig("compaction", {
    provider: "openrouter",
    model: "google/gemini-3-flash-preview",
  });
}

/**
 * Custom Compaction Extension
 *
 * Uses a cheaper/faster model for summarization while reusing all of pi's
 * built-in compaction logic (prompts, file tracking, split-turn handling, etc.)
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;

    // Read compaction model settings from pi settings file (with defaults)
    const compactionSettings = readCompactionSettings();
    const { provider, model: modelId } = compactionSettings;

    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(
        `Could not find compaction model ${provider}/${modelId}, using default compaction`,
        "warning",
      );
      return;
    }

    // Resolve request auth for the summarization model
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify(
        `Compaction auth unavailable for ${model.id}, using default compaction`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      `Custom compaction: using ${model.id} for summarization (${preparation.tokensBefore.toLocaleString()} tokens)...`,
      "info",
    );

    try {
      // Use pi's built-in compact() function with our custom model
      // This reuses ALL of pi's built-in logic:
      // - SUMMARIZATION_SYSTEM_PROMPT
      // - SUMMARIZATION_PROMPT / UPDATE_SUMMARIZATION_PROMPT
      // - TURN_PREFIX_SUMMARIZATION_PROMPT for split turns
      // - File operations tracking
      // - Proper message serialization
      // - All edge case handling
      const result = await compact(
        preparation,
        model,
        auth.apiKey,
        auth.headers,
        customInstructions,
        signal,
      );

      // Return the compaction result
      return {
        compaction: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Custom compaction failed: ${message}`, "error");
      // Fall back to default compaction on error
      return;
    }
  });
}
