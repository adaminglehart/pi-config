/**
 * Token estimation utilities for LCM.
 * Simple character-count heuristic matching lossless-claw.
 */

/**
 * Estimate token count for text content.
 * Uses a simple heuristic: chars / 3.5
 * This is fast and good enough for budget calculations.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate tokens for message content, handling both string and object content.
 */
export function estimateMessageTokens(content: string | object): number {
  if (typeof content === "string") {
    return estimateTokens(content);
  }

  // If content is an object, serialize it
  const serialized = JSON.stringify(content);
  return estimateTokens(serialized);
}
