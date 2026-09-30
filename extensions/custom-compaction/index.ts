import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { findModelAuth } from "../_lib/model-auth.js";
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

    const auth = await findModelAuth(ctx.modelRegistry, provider, modelId);
    if (!auth.ok || !auth.apiKey) {
      const reason = auth.ok
        ? `No API key for ${provider}/${modelId}.`
        : auth.error;
      ctx.ui.notify(`${reason} Using default compaction.`, "warning");
      return;
    }
    const { model } = auth;

    ctx.ui.notify(
      `Custom compaction: using ${model.id} for summarization (${preparation.tokensBefore.toLocaleString()} tokens)...`,
      "info",
    );

    // Pi 0.84's runtime compact path accepts ProviderHeaders, but its
    // published helper declaration still exposes the pre-0.84 string-only
    // shape. Preserve null deletion markers across that declaration gap.
    const compactionHeaders = auth.headers as
      | Record<string, string>
      | undefined;

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
        compactionHeaders,
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
