/**
 * Format helpers for converting between stored DB records and Pi-compatible messages.
 */

import type { MessageRecord, SummaryRecord } from "./types.js";

/**
 * Format a summary as an XML-wrapped block for injection into LLM context.
 */
export function formatSummaryBlock(summary: SummaryRecord): string {
  return `<summary id="${summary.id}" kind="${summary.kind}" depth="${summary.depth}">\n${summary.content}\n</summary>`;
}

/**
 * Wrap one or more summary blocks into a context injection message.
 */
export function formatSummariesAsMessage(
  summaries: SummaryRecord[],
): { role: string; content: Array<{ type: string; text: string }> } {
  const blocks = summaries.map(formatSummaryBlock).join("\n\n");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Historical Context — Compressed Summaries]\n\n${blocks}`,
      },
    ],
  };
}

/**
 * Convert a stored message record back into a Pi-compatible LLM message.
 */
export function formatStoredMessageAsLlmMessage(
  message: MessageRecord,
): { role: string; content: string | Array<{ type: string; text: string }> } {
  // Try to parse content as JSON array (content blocks)
  if (message.content.startsWith("[")) {
    try {
      const parsed = JSON.parse(message.content) as Array<{ type: string; text: string }>;
      if (Array.isArray(parsed)) {
        return { role: mapRole(message.role), content: parsed };
      }
    } catch {
      // Not valid JSON array, treat as plain text
    }
  }

  return {
    role: mapRole(message.role),
    content: [{ type: "text", text: message.content }],
  };
}

/**
 * Map stored DB role to Pi message role.
 */
function mapRole(role: string): string {
  if (role === "tool" || role === "toolResult") return "user";
  return role;
}
