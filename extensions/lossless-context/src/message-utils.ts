/**
 * Message content extraction and identity hashing utilities.
 * Handles Pi's various message content formats for storage and FTS indexing.
 */

import { createHash } from "node:crypto";

/**
 * Generic message shape that covers all Pi message types
 */
interface MessageLike {
  role: string;
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  toolName?: string;
  [key: string]: unknown;
}

/**
 * Extract text content from a Pi message for storage and FTS indexing.
 *
 * Handles:
 * - String content (simple messages)
 * - Content block arrays (extract text blocks)
 * - Tool results (prefix with tool name)
 */
export function extractTextContent(message: MessageLike): string {
  const { role, content } = message;

  // Handle string content
  if (typeof content === "string") {
    return content;
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const block of content) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool_use" && "toolName" in block) {
        // Include tool calls in searchable content
        textParts.push(`[tool: ${String(block.toolName)}]`);
      }
    }

    return textParts.join("\n");
  }

  // Tool results: prefix with tool name for context
  if (role === "toolResult" && "toolName" in message) {
    return `[${String(message.toolName)}] ${JSON.stringify(content || "")}`;
  }

  // Fallback: serialize whatever we have
  return content ? JSON.stringify(content) : "";
}

/**
 * Compute a stable identity hash for message deduplication.
 * Used to detect if the same message content was stored multiple times.
 */
export function computeIdentityHash(role: string, content: string): string {
  return createHash("sha256").update(`${role}:${content}`).digest("hex");
}
