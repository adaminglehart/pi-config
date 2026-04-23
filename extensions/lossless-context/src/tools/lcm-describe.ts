/**
 * lcm_describe tool: Get metadata and lineage for a specific summary.
 * Shows parent/child relationships in the DAG, source messages, and metadata.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RetrievalEngine } from "../retrieval.js";

export function registerDescribeTool(
  pi: ExtensionAPI,
  getEngine: () => RetrievalEngine | undefined,
) {
  pi.registerTool({
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Get metadata and lineage for a specific summary. Shows parent/child relationships in the summary DAG, source messages, depth, and creation time.",
    promptSnippet:
      "Inspect a summary's metadata, lineage (parents/children), and source messages",
    parameters: Type.Object({
      summary_id: Type.String({
        description: "The summary ID to describe (e.g. from lcm_grep results)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const engine = getEngine();
      if (!engine) throw new Error("LCM not initialized");

      const result = engine.describe(params.summary_id);
      if (!result) {
        throw new Error(`Summary not found: ${params.summary_id}`);
      }

      const lines: string[] = [
        `## Summary: ${result.summary.id}`,
        `- Kind: ${result.summary.kind}`,
        `- Depth: ${result.summary.depth}`,
        `- Tokens: ${result.summary.token_count}`,
        `- Created: ${result.summary.created_at}`,
        "",
        "### Content",
        result.summary.content,
      ];

      if (result.parentIds.length > 0) {
        lines.push(
          "",
          "### Parent Summary IDs (this condensed summary was created from)",
        );
        for (const pid of result.parentIds) lines.push(`- ${pid}`);
      }

      if (result.childSummaries.length > 0) {
        lines.push(
          "",
          "### Child Summaries (summaries that were condensed into this one)",
        );
        for (const child of result.childSummaries) {
          lines.push(
            `- ${child.id} (${child.kind}, depth ${child.depth}, ${child.token_count} tokens)`,
          );
        }
      }

      if (result.sourceMessageIds.length > 0) {
        lines.push(
          "",
          `### Source Messages (${result.sourceMessageIds.length} messages summarized)`,
        );
        for (const mid of result.sourceMessageIds) lines.push(`- ${mid}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });
}
