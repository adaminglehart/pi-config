/**
 * Sanitize user-provided queries for FTS5 MATCH expressions.
 *
 * FTS5 treats certain characters as operators (-, +, *, ^, OR, AND, NOT, :, ", (, ), NEAR).
 * This wrapper ensures queries are treated as literal text by wrapping each token in quotes.
 *
 * Strategy: Preserve user-quoted phrases, then wrap remaining tokens in double quotes.
 * Empty tokens are dropped. Tokens are joined with spaces (implicit AND).
 *
 * Examples:
 *   "sub-agent restrict"  →  '"sub-agent" "restrict"'
 *   "lcm_expand OR crash" →  '"lcm_expand" "OR" "crash"'
 *   'hello "world"'       →  '"hello" "world"'
 */
export function sanitizeFts5Query(raw: string): string {
  const parts: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  // Extract quoted phrases first
  while ((match = phraseRegex.exec(raw)) !== null) {
    // Process unquoted text before this phrase
    const before = raw.slice(lastIndex, match.index);
    for (const token of before.split(/\s+/).filter(Boolean)) {
      parts.push(`"${token.replace(/"/g, "")}"`);
    }
    // Preserve the phrase (strip internal quotes for safety)
    const phrase = match[1].replace(/"/g, "").trim();
    if (phrase) {
      parts.push(`"${phrase}"`);
    }
    lastIndex = match.index + match[0].length;
  }

  // Process remaining unquoted text
  for (const token of raw.slice(lastIndex).split(/\s+/).filter(Boolean)) {
    parts.push(`"${token.replace(/"/g, "")}"`);
  }

  return parts.length > 0 ? parts.join(" ") : '""';
}
