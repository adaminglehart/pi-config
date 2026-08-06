import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { decodeStoredMessage } from "./message-codec.js";
import type { MessageRecord, SummaryRecord } from "./types.js";

export function formatSummaryBlock(summary: SummaryRecord): string {
  return `<summary id="${summary.id}" kind="${summary.kind}" depth="${summary.depth}">\n${summary.content}\n</summary>`;
}

/** Wrap summaries in a valid synthetic user message for provider context. */
export function formatSummariesAsMessage(
  summaries: SummaryRecord[],
): AgentMessage {
  const blocks = summaries.map(formatSummaryBlock).join("\n\n");
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Historical Context — Compressed Summaries]\n\n${blocks}`,
      },
    ],
    timestamp: 0,
  };
}

/** Decode exact canonical data, or an explicitly marked legacy wrapper. */
export function formatStoredMessageAsLlmMessage(
  message: MessageRecord,
): AgentMessage {
  return decodeStoredMessage(message).message;
}
