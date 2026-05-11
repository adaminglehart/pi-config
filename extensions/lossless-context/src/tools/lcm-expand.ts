/**
 * lcm_expand tool: Drill into a summary to recover original detail.
 * For leaf summaries: returns source messages.
 * For condensed summaries: returns child summaries.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RetrievalEngine } from "../retrieval.js";
import type { LcmConfig } from "../types.js";

export function registerExpandTool(
  pi: ExtensionAPI,
  getEngine: () => RetrievalEngine | undefined,
  getConfig: () => LcmConfig,
) {
  pi.registerTool({
    name: "lcm_expand",
    label: "LCM Expand",
    description:
      "Drill into a summary to recover the original detail. For leaf summaries, returns the source messages. For condensed summaries, returns the child summaries. This is the 'lossless' part — nothing is ever truly lost.",
    promptSnippet:
      "Drill into a summary to recover original messages or child summaries",
    promptGuidelines: [
      "Use lcm_expand after lcm_grep or lcm_describe to recover full original context from a summary. Chain lcm_expand calls to drill deeper through condensed → leaf → raw messages.",
    ],
    parameters: Type.Object({
      summary_id: Type.String({ description: "Summary ID to expand" }),
      max_tokens: Type.Optional(
        Type.Number({
          description: "Token limit for expansion. Default: from config (4000)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const engine = getEngine();
      if (!engine) throw new Error("LCM not initialized");

      const config = getConfig();
      const maxTokens = params.max_tokens ?? config.maxExpandTokens;

      const result = engine.expand(params.summary_id, maxTokens);
      if (!result) {
        throw new Error(`Summary not found: ${params.summary_id}`);
      }

      const lines: string[] = [
        `## Expanded: ${params.summary_id} (${result.totalTokens} tokens)`,
      ];

      for (const item of result.items) {
        if (item.type === "message") {
          lines.push(`\n### [${item.role}] Message ${item.id}`);
          lines.push(item.content);
        } else {
          lines.push(`\n### [${item.kind} d${item.depth}] Summary ${item.id}`);
          lines.push(item.content);
          lines.push(
            `\n*(Use lcm_expand with summary_id="${item.id}" to drill deeper)*`,
          );
        }
      }

      if (result.items.length === 0) {
        lines.push("\nNo items found (source messages may have been pruned).");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });
}
