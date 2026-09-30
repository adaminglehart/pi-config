/**
 * Text fallback for `query` position resolution: the first whole-word
 * occurrence of an identifier in a file.
 */

const IDENTIFIER_CHAR = "[\\p{L}\\p{N}_$]";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns a 1-indexed line and column (UTF-16 code units, as LSP expects). */
export function findWordPosition(
  text: string,
  word: string,
): { line: number; column: number } | null {
  if (!word) return null;
  const pattern = new RegExp(
    `(?<!${IDENTIFIER_CHAR})${escapeRegExp(word)}(?!${IDENTIFIER_CHAR})`,
    "u",
  );
  const match = pattern.exec(text);
  if (!match) return null;
  const before = text.slice(0, match.index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line, column: match.index - lineStart + 1 };
}
