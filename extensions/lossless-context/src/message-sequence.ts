import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type MessageSequenceResult = { valid: true } | { valid: false; reason: string };

/** Validate provider tool-call groups without logging message bodies. */
export function validateMessageSequence(messages: readonly AgentMessage[]): MessageSequenceResult {
  let pending: Set<string> | undefined;
  const completed = new Set<string>();

  for (const message of messages) {
    if (message.role === "toolResult") {
      if (!pending?.has(message.toolCallId)) return { valid: false, reason: "orphan or duplicate tool result" };
      pending.delete(message.toolCallId);
      completed.add(message.toolCallId);
      if (pending.size === 0) pending = undefined;
      continue;
    }

    if (pending) return { valid: false, reason: "tool result group was interrupted" };

    if (message.role === "assistant") {
      const calls = message.content.filter((block) => block.type === "toolCall");
      if (calls.length > 0) {
        const ids = calls.map((call) => call.id);
        if (new Set(ids).size !== ids.length || ids.some((id) => completed.has(id))) {
          return { valid: false, reason: "duplicate tool call id" };
        }
        pending = new Set(ids);
      }
    }
  }

  return pending ? { valid: false, reason: "dangling tool call" } : { valid: true };
}
