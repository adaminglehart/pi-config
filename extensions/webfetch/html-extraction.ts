/**
 * Extract the main content of an HTML page with Defuddle.
 *
 * Falls back to a tag-strip of the <body> when Defuddle throws or returns
 * empty content.
 */

import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { htmlToPlainText } from "./html-plain-text.js";
import { stripHtmlTags } from "./html-tag-strip.js";

export type HtmlExtractionFormat = "markdown" | "text";
export type HtmlExtractionMethod = "defuddle" | "tag-strip";

export interface HtmlExtraction {
  content: string;
  method: HtmlExtractionMethod;
  fallbackReason?: string;
}

/**
 * @param pageUrl Final response URL. Defuddle uses it to resolve relative links.
 */
export async function extractHtmlContent(
  html: string,
  pageUrl: string,
  format: HtmlExtractionFormat,
): Promise<HtmlExtraction> {
  let fallbackReason: string;
  try {
    const { document } = parseHTML(html);
    // useAsync: false keeps the tool to one request for the given URL.
    // Defuddle async extractors call third-party APIs (for example FxTwitter).
    const result = await Defuddle(document, pageUrl, {
      markdown: format === "markdown",
      useAsync: false,
      // Pattern matching can remove words inside code blocks (for example
      // `result.author`). Keep source text intact for code documentation.
      removeContentPatterns: false,
    });
    const content =
      format === "markdown"
        ? result.content.trim()
        : htmlToPlainText(result.content);
    if (content) {
      return {
        method: "defuddle",
        content:
          format === "markdown"
            ? addMarkdownHeader(result.title, pageUrl, content)
            : content,
      };
    }
    fallbackReason = "Defuddle returned empty content";
  } catch (error: unknown) {
    fallbackReason = `Defuddle failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  const text = stripHtmlTags(html);
  return {
    method: "tag-strip",
    fallbackReason,
    content: format === "markdown" ? addMarkdownHeader("", pageUrl, text) : text,
  };
}

function addMarkdownHeader(
  title: string,
  pageUrl: string,
  content: string,
): string {
  const header = title.trim()
    ? `# ${title.trim()}\n\nSource: ${pageUrl}`
    : `Source: ${pageUrl}`;
  return content ? `${header}\n\n${content}` : header;
}
