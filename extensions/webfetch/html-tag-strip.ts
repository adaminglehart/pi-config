/**
 * Fallback HTML-to-text conversion used when Defuddle fails or returns empty
 * content. It strips tags from the <body> without a DOM.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

export function stripHtmlTags(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|template|svg|iframe|object)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|ul|ol|table)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    (entity: string, code: string) => {
      if (code.startsWith("#x") || code.startsWith("#X")) {
        return decodeCodePoint(Number.parseInt(code.slice(2), 16), entity);
      }
      if (code.startsWith("#")) {
        return decodeCodePoint(Number.parseInt(code.slice(1), 10), entity);
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    },
  );
}

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}
