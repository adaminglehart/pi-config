/**
 * Summarization LLM calls for LCM.
 * Uses Pi's model registry and completeSimple API.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { LcmConfig } from "./types.js";
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
} from "./summarize-prompts.js";

export interface SummarizationDeps {
  modelRegistry: ModelRegistry;
  config: LcmConfig;
  signal?: AbortSignal;
}

/**
 * Summarize content using the configured summary model.
 */
export async function summarize(
  content: string,
  kind: "leaf" | "condensed",
  depth: number,
  deps: SummarizationDeps,
  aggressive: boolean = false,
): Promise<string> {
  // Determine target tokens based on kind and config
  const targetTokens =
    kind === "leaf"
      ? deps.config.leafTargetTokens
      : deps.config.condensedTargetTokens;

  // Build the prompt
  const userPrompt =
    kind === "leaf"
      ? buildLeafSummaryPrompt(content, targetTokens, aggressive)
      : buildCondensedSummaryPrompt(content, depth, targetTokens);

  // Resolve model from registry
  const model = deps.modelRegistry.find(
    deps.config.summaryProvider,
    deps.config.summaryModel,
  );
  if (!model) {
    throw new Error(
      `Failed to find summary model: ${deps.config.summaryProvider}/${deps.config.summaryModel}`,
    );
  }

  // Get auth
  const auth = await deps.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(
      `Failed to resolve auth for summary model ${model.id}: ${auth.error}`,
    );
  }

  // Call the LLM
  try {
    const response = await completeSimple(
      model,
      {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: userPrompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: targetTokens,
        temperature: 0,
        signal: deps.signal,
      },
    );

    // Extract text from response
    const text = extractTextFromResponse(response);

    if (!text || text.trim().length === 0) {
      throw new Error(
        "Summary model returned empty response. This may indicate a model configuration issue.",
      );
    }

    return text.trim();
  } catch (error) {
    // If summarization fails, return a truncated version of the original content
    // This keeps compaction monotonic instead of failing the entire pass
    console.error("LCM summarization error:", error);
    return buildFallbackSummary(content, targetTokens);
  }
}

/**
 * Extract text content from completeSimple response.
 */
function extractTextFromResponse(
  response: Awaited<ReturnType<typeof completeSimple>>,
): string {
  const parts: string[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }

  return parts.join("\n");
}

/**
 * Build a deterministic fallback summary when LLM fails.
 * Truncates to target token count (rough estimate: 4 chars per token).
 */
function buildFallbackSummary(content: string, targetTokens: number): string {
  if (!content || content.trim().length === 0) {
    return "";
  }

  const maxChars = Math.max(256, targetTokens * 4);
  const trimmed = content.trim();

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return (
    trimmed.slice(0, maxChars) +
    "\n[LCM fallback summary; truncated for context management]"
  );
}
