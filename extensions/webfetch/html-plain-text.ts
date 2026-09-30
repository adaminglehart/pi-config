/**
 * Convert extracted HTML (Defuddle main content) to readable plain text.
 *
 * Block elements become paragraphs, list items become "- " lines, and
 * <pre> blocks keep their original whitespace.
 */

import { parseHTML } from "linkedom";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TR",
  "UL",
]);

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

interface TextSegment {
  preformatted: boolean;
  text: string;
}

export function htmlToPlainText(html: string): string {
  const { document } = parseHTML(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
  );
  const segments: TextSegment[] = [{ preformatted: false, text: "" }];
  appendChildText(document.body, segments);
  return segments
    .map(formatSegment)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function appendChildText(node: Node, segments: TextSegment[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      appendFlowText(segments, (child.textContent ?? "").replace(/\s+/g, " "));
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;

    const element = child as Element;
    const tag = element.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) continue;

    if (tag === "BR") {
      appendFlowText(segments, "\n");
    } else if (tag === "PRE") {
      segments.push({ preformatted: true, text: element.textContent ?? "" });
    } else if (tag === "LI") {
      appendFlowText(segments, "\n- ");
      appendChildText(element, segments);
      appendFlowText(segments, "\n");
    } else if (tag === "TD" || tag === "TH") {
      appendChildText(element, segments);
      appendFlowText(segments, "\t");
    } else if (BLOCK_TAGS.has(tag)) {
      appendFlowText(segments, "\n\n");
      appendChildText(element, segments);
      appendFlowText(segments, "\n\n");
    } else {
      appendChildText(element, segments);
    }
  }
}

function appendFlowText(segments: TextSegment[], text: string): void {
  const last = segments[segments.length - 1];
  if (last && !last.preformatted) {
    last.text += text;
  } else {
    segments.push({ preformatted: false, text });
  }
}

function formatSegment(segment: TextSegment): string {
  if (segment.preformatted) {
    return segment.text.replace(/^\n+/, "").trimEnd();
  }
  return segment.text
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
