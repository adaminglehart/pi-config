/**
 * lcm_grep tool: Search through conversation history.
 * Searches both raw messages and compacted summaries.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RetrievalEngine } from "../retrieval.js";

export function registerGrepTool(
  pi: ExtensionAPI,
  getEngine: () => RetrievalEngine | undefined,
  getConversationId: () => string | undefined,
) {
  pi.registerTool({
    name: "lcm_grep",
    label: "LCM Grep",
    description:
      "Search through all conversation history including compacted summaries. Use this to find past discussions, decisions, code changes, or any historical context.",
    promptSnippet:
      "Search all conversation history (raw messages and summaries) by keyword or phrase",
    promptGuidelines: [
      "Use lcm_grep when you need to recall past conversation context, find previous decisions, or search for specific topics discussed earlier in the session.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query — keywords or phrase to find",
      }),
      scope: StringEnum(["messages", "summaries", "both"] as const, {
        description: "Where to search. Default: both",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max results to return. Default: 20" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const engine = getEngine();
      const conversationId = getConversationId();
      if (!engine || !conversationId) {
        throw new Error("LCM not initialized");
      }

      const result = engine.grep(
        params.query,
        conversationId,
        params.scope ?? "both",
        params.limit ?? 20,
      );

      const lines: string[] = [];
      if (result.messages.length > 0) {
        lines.push(`## Messages (${result.messages.length} matches)`);
        for (const m of result.messages) {
          lines.push(
            `- [${m.role}] (seq ${m.seq}, ${m.created_at}): ${m.snippet}`,
          );
        }
      }
      if (result.summaries.length > 0) {
        lines.push(`\n## Summaries (${result.summaries.length} matches)`);
        for (const s of result.summaries) {
          lines.push(`- [${s.kind} d${s.depth}] ${s.id}: ${s.snippet}`);
        }
      }
      if (lines.length === 0) {
        lines.push("No matches found.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });
}
