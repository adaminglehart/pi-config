/**
 * WebFetch Tool - Fetch and convert web content
 *
 * Fetches content from URLs and converts to requested format (markdown, text, or html).
 * HTML main content is extracted with Defuddle. Images are returned as image content.
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
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractHtmlContent,
  type HtmlExtractionMethod,
} from "./html-extraction.js";
import { safeImageContent } from "./image-content.js";

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
  imageUnsupported?: boolean;
  imageMime?: string;
  extraction?: HtmlExtractionMethod;
  extractionFallbackReason?: string;
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
- Extracts the main content of HTML pages with Defuddle: "markdown" adds the page title and source URL at the top, "text" returns plain text, "html" returns the raw HTML
- Returns images as image attachments
- Respects robots.txt and uses proper User-Agent
- Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} if too large

Use this tool when you need to retrieve and analyze web content.`,
    promptSnippet:
      "Fetch content from a URL and convert to markdown, text, or html",
    promptGuidelines: [
      "Use webfetch when you need to retrieve and analyze web content.",
      "URL must start with http:// or https://",
      "Output is automatically truncated if too large.",
    ],
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
          const image = await safeImageContent(new Uint8Array(arrayBuffer));
          if (!image) {
            return {
              content: [{
                type: "text",
                text: `Fetched image from ${url}, but it could not be sent to the model. Only valid PNG, JPEG, GIF and WebP images within the size and dimension limits are supported.`,
              }],
              details: { url, format, contentType: mime, size: arrayBuffer.byteLength, imageUnsupported: true },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Image fetched successfully from ${url} [${image.mimeType}, ${formatSize(arrayBuffer.byteLength)}]`,
              },
              { type: "image", data: image.data, mimeType: image.mimeType },
            ],
            details: {
              url,
              format,
              contentType: mime,
              size: arrayBuffer.byteLength,
              isImage: true,
              imageMime: image.mimeType,
            } as WebFetchDetails,
          };
        }

        const content = new TextDecoder().decode(arrayBuffer);
        const isHtml = contentType.includes("text/html");

        // Process content based on requested format
        let processedContent: string;
        let extraction: HtmlExtractionMethod | undefined;
        let extractionFallbackReason: string | undefined;

        if (isHtml && (format === "markdown" || format === "text")) {
          const extracted = await extractHtmlContent(
            content,
            response.url || url,
            format,
          );
          processedContent = extracted.content;
          extraction = extracted.method;
          extractionFallbackReason = extracted.fallbackReason;
        } else {
          processedContent = content;
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
          extraction,
          extractionFallbackReason,
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

      if (details?.imageUnsupported) {
        text = theme.fg("warning", "Image could not be sent to the model");
      } else if (details?.isImage) {
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
        if (details?.extraction === "tag-strip") {
          text += theme.fg("warning", " (fallback extraction)");
        }
      }

      // In expanded view, show more details
      if (expanded && details) {
        text += `\n${theme.fg("dim", `URL: ${details.url}`)}`;
        text += `\n${theme.fg("dim", `Format: ${details.format}`)}`;
        if (details.contentType) {
          text += `\n${theme.fg("dim", `Content-Type: ${details.contentType}`)}`;
        }
        if (details.extractionFallbackReason) {
          text += `\n${theme.fg("dim", `Extraction: tag-strip (${details.extractionFallbackReason})`)}`;
        }
        if (details.fullOutputPath) {
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
