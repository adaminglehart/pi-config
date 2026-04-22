/**
 * WebFetch Tool - Fetch and convert web content
 *
 * Fetches content from URLs and converts to requested format (markdown, text, or html).
 * Handles timeouts, size limits, and content type detection.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
  ToolRenderResultOptions,
  Theme,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text, type TUI, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { tmpdir } from "os";
import { join } from "path";

// Size limits (matching opencode's implementation)
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30 * 1000; // 30 seconds
const MAX_TIMEOUT = 120 * 1000; // 2 minutes

const WebFetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch content from" }),
  format: Type.Optional(
    Type.String({
      description:
        'The format to return the content in: "markdown" (default), "text", or "html"',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Optional timeout in seconds (max 120)" }),
  ),
});

type WebFetchFormat = "markdown" | "text" | "html";

interface WebFetchDetails {
  url: string;
  format: WebFetchFormat;
  contentType?: string;
  size: number;
  truncated?: boolean;
  fullOutputPath?: string;
  isImage?: boolean;
  imageMime?: string;
}

// Simple HTML to text extraction
function extractTextFromHTML(html: string): string {
  // Remove script and style tags and their content
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>[\s\S]*?<\/embed>/gi, "");

  // Replace common block elements with newlines
  text = text
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "\n- ");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");

  // Clean up whitespace
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// Simple HTML to Markdown conversion
function convertHTMLToMarkdown(html: string): string {
  // First extract text
  let text = html;

  // Convert headers
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n");
  text = text.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n\n");
  text = text.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n\n");

  // Convert bold and italic
  text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, "*$2*");

  // Convert code
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "```\n$1\n```\n\n");

  // Convert links
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");

  // Convert images
  text = text.replace(
    /<img[^>]+src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
    "![$2]($1)",
  );
  text = text.replace(/<img[^>]+src="([^"]*)"[^>]*\/?>/gi, "![]($1)");

  // Convert lists
  text = text.replace(/<ul[^>]*>[\s\S]*?<\/ul>/gi, (match) => {
    return match.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  });
  text = text.replace(/<ol[^>]*>[\s\S]*?<\/ol>/gi, (match) => {
    let index = 1;
    return match.replace(/<li[^>]*>(.*?)<\/li>/gi, () => `${index++}. $1\n`);
  });

  // Convert blockquotes
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (match, content) => {
      return content
        .split("\n")
        .map((line: string) => `> ${line}`)
        .join("\n");
    },
  );

  // Convert horizontal rules
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n\n");

  // Convert paragraphs
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");

  // Convert line breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Remove script and style tags and their content
  text = text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");

  // Clean up whitespace
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof WebFetchParams, WebFetchDetails>({
    name: "webfetch",
    label: "WebFetch",
    description: `Fetches content from a URL and returns it in the requested format.

Parameters:
- url: The URL to fetch (must start with http:// or https://)
- format: The output format - "markdown" (default), "text", or "html"
- timeout: Optional timeout in seconds (max 120, default 30)

Features:
- Automatically converts HTML to markdown or plain text
- Handles images (returns as base64 data URI in markdown format)
- Respects robots.txt and uses proper User-Agent
- Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} if too large

Use this tool when you need to retrieve and analyze web content.`,
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { url } = params;
      const format = (params.format || "markdown") as WebFetchFormat;
      const timeout = Math.min(
        (params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000,
        MAX_TIMEOUT,
      );

      // Validate URL
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://");
      }

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Link external signal if provided
      if (signal) {
        signal.addEventListener("abort", () => controller.abort());
      }

      try {
        // Build Accept header based on requested format
        let acceptHeader = "*/*";
        switch (format) {
          case "markdown":
            acceptHeader =
              "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
            break;
          case "text":
            acceptHeader =
              "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
            break;
          case "html":
            acceptHeader =
              "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
            break;
        }

        const headers = {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: acceptHeader,
          "Accept-Language": "en-US,en;q=0.9",
        };

        let response: Response;
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers,
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") {
            throw new Error(
              `Request timed out after ${timeout / 1000} seconds`,
            );
          }
          throw new Error(
            `Failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Retry with honest UA if blocked by Cloudflare
        if (
          response.status === 403 &&
          response.headers.get("cf-mitigated") === "challenge"
        ) {
          try {
            response = await fetch(url, {
              signal: controller.signal,
              headers: { ...headers, "User-Agent": "pi-agent/1.0" },
            });
          } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") {
              throw new Error(
                `Request timed out after ${timeout / 1000} seconds`,
              );
            }
            // Continue with original response if retry fails
          }
        }

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(
            `Request failed with status code: ${response.status}`,
          );
        }

        // Check content length
        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
          throw new Error(
            `Response too large (exceeds ${formatSize(MAX_RESPONSE_SIZE)} limit)`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
          throw new Error(
            `Response too large (exceeds ${formatSize(MAX_RESPONSE_SIZE)} limit)`,
          );
        }

        const contentType = response.headers.get("content-type") || "";
        const mime = contentType.split(";")[0]?.trim().toLowerCase() || "";

        // Check if response is an image
        const isImage =
          mime.startsWith("image/") &&
          mime !== "image/svg+xml" &&
          mime !== "image/vnd.fastbidsheet";

        if (isImage) {
          const base64Content = Buffer.from(arrayBuffer).toString("base64");
          const dataUrl = `data:${mime};base64,${base64Content}`;

          return {
            content: [
              {
                type: "text",
                text: `Image fetched successfully from ${url}\n\n![Image](${dataUrl})`,
              },
            ],
            details: {
              url,
              format,
              contentType: mime,
              size: arrayBuffer.byteLength,
              isImage: true,
              imageMime: mime,
            } as WebFetchDetails,
          };
        }

        const content = new TextDecoder().decode(arrayBuffer);

        // Process content based on requested format
        let processedContent: string;

        switch (format) {
          case "markdown":
            if (contentType.includes("text/html")) {
              processedContent = convertHTMLToMarkdown(content);
            } else {
              processedContent = content;
            }
            break;

          case "text":
            if (contentType.includes("text/html")) {
              processedContent = extractTextFromHTML(content);
            } else {
              processedContent = content;
            }
            break;

          case "html":
          default:
            processedContent = content;
            break;
        }

        // Apply truncation using pi's built-in utilities
        const truncation = truncateHead(processedContent, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        const details: WebFetchDetails = {
          url,
          format,
          contentType: mime,
          size: arrayBuffer.byteLength,
        };

        let resultText = truncation.content;

        if (truncation.truncated) {
          // Save full output to a temp file so LLM can access it if needed
          const tempDir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
          const tempFile = join(tempDir, "output.txt");
          await writeFile(tempFile, processedContent, "utf8");

          details.truncated = true;
          details.fullOutputPath = tempFile;

          // Add truncation notice
          resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
          resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
          resultText += ` Full output saved to: ${tempFile}]`;
        }

        return {
          content: [{ type: "text", text: resultText }],
          details,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    // Custom rendering of the tool call
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "));
      text += theme.fg("accent", `"${args.url}"`);
      if (args.format && args.format !== "markdown") {
        text += theme.fg("dim", ` --format ${args.format}`);
      }
      if (args.timeout) {
        text += theme.fg("dim", ` --timeout ${args.timeout}s`);
      }
      return new Text(text, 0, 0);
    },

    // Custom rendering of the tool result
    renderResult(
      result: AgentToolResult<WebFetchDetails>,
      { expanded, isPartial }: ToolRenderResultOptions,
      theme: Theme,
    ): Component {
      const details = result.details;

      // Handle streaming/partial results
      if (isPartial) {
        return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      }

      // Build result display
      let text = "";

      if (details?.isImage) {
        text = theme.fg(
          "success",
          `✓ Image fetched (${formatSize(details.size)})`,
        );
      } else {
        text = theme.fg(
          "success",
          `✓ Fetched ${formatSize(details?.size || 0)}`,
        );
        if (details?.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
      }

      // In expanded view, show more details
      if (expanded && details) {
        text += `\n${theme.fg("dim", `URL: ${details.url}`)}`;
        text += `\n${theme.fg("dim", `Format: ${details.format}`)}`;
        if (details.contentType) {
          text += `\n${theme.fg("dim", `Content-Type: ${details.contentType}`)}`;
        }
        if (details.fullOutputPath) {
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
