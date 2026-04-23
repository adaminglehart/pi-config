/**
 * Message and summary serialization for summarization prompts.
 */

/**
 * Serialize messages for leaf summary prompts.
 * Format: [Role]: content
 */
export function serializeMessagesForSummary(
  messages: Array<{ role: string; content: string }>,
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    // Truncate individual messages to prevent prompt explosion
    const truncated = truncateMessage(msg.content, 2000);
    const roleLabel = formatRoleLabel(msg.role);
    lines.push(`[${roleLabel}]: ${truncated}`);
  }

  return lines.join("\n\n");
}

/**
 * Serialize summaries for condensed summary prompts.
 * Include depth marker for each summary.
 */
export function serializeSummariesForCondensation(
  summaries: Array<{ content: string; depth: number }>,
): string {
  const lines: string[] = [];

  for (const summary of summaries) {
    lines.push(
      `--- Depth ${summary.depth} Summary ---\n${summary.content}\n`,
    );
  }

  return lines.join("\n");
}

/**
 * Format role for display in serialized messages.
 */
function formatRoleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

/**
 * Truncate message content to a maximum character count.
 * Adds ellipsis if truncated.
 */
function truncateMessage(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return content.slice(0, maxChars) + "...[truncated]";
}
