/**
 * Minimal Tools Extension
 *
 * Shows compact tool indicators in the main chat:
 * - Tool call: icon + name + minimal args
 * - Tool result: just ✓ or ✗ (or count for search tools)
 * - Full output hidden until Ctrl+O expands
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  truncateHead,
  truncateTail,
  formatSize,
  DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

// Output truncation limits
const MAX_EXPANDED_LINES = 50; // Lines to show when expanded
const STREAMING_PREVIEW_LINES = 5; // Recent lines to show while streaming

// Parameter schemas
const ReadParams = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

const BashParams = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});

const WriteParams = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const EditParams = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
});

// The underlying edit tool expects this format at runtime
interface EditInternalParams {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

const FindParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

const GrepParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

const LsParams = Type.Object({
  path: Type.Optional(Type.String()),
});

// Helper functions
function shortenPath(path: string): string {
  const home = process.env.HOME || "";
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function getTextContent(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const textItem = result.content.find(
    (c): c is TextContent => c.type === "text",
  );
  return textItem?.text || "";
}

function truncateOutput(text: string): { text: string; wasTruncated: boolean } {
  const result = truncateHead(text, {
    maxLines: MAX_EXPANDED_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return { text: result.content, wasTruncated: result.truncated };
}

/**
 * Get the most recent N lines from text using built-in truncateTail.
 * Returns formatted output with truncation info prefix if truncated.
 */
function getRecentLines(text: string, n: number, theme: any): string {
  const result = truncateTail(text, {
    maxLines: n,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (result.truncated) {
    const skipped = result.totalLines - result.outputLines;
    return theme.fg("dim", `... (${skipped} earlier lines)\n`) + result.content;
  }
  return result.content;
}

/**
 * Store streaming state in context.state for dynamic updates
 */
interface StreamingState {
  outputBuffer: string;
  lastUpdateTime: number;
}

export default function (pi: ExtensionAPI) {
  // Read Tool
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read the contents of a file.",
    promptSnippet: "Read the contents of a file",
    promptGuidelines: [
      "Use read to examine file contents before making changes.",
      "Prefer grep or find first if you're unsure of the file path.",
    ],
    parameters: ReadParams,

    async execute(
      toolCallId,
      params: Static<typeof ReadParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createReadTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args: Static<typeof ReadParams>, theme) {
      const path = shortenPath(args.path || "");
      let display = path || "...";
      if (args.offset !== undefined || args.limit !== undefined) {
        const start = args.offset ?? 1;
        const end = args.limit !== undefined ? start + args.limit - 1 : "";
        display += `:${start}${end ? `-${end}` : ""}`;
      }
      return new Text(
        ` ${theme.fg("dim", "→")} ${theme.fg("toolTitle", "read")} ${theme.fg("accent", display)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = getTextContent(result);
      const state = context.state as StreamingState | undefined;

      // While streaming large files, show progress
      if (isPartial && !expanded && text.length > 1000) {
        if (!state) {
          context.state = {
            outputBuffer: text,
            lastUpdateTime: Date.now(),
          } as StreamingState;
        } else {
          state.outputBuffer = text;
          state.lastUpdateTime = Date.now();
        }

        const lines = text.split("\n").length;
        const recent = getRecentLines(
          text,
          Math.min(STREAMING_PREVIEW_LINES, lines),
          theme,
        );
        const status = theme.fg(
          "warning",
          ` ⟳ Reading ${formatSize(text.length)}...`,
        );

        return new Text(`${status}\n${theme.fg("toolOutput", recent)}`, 0, 0);
      }

      if (!expanded) {
        const lines = text ? text.split("\n") : [];
        const size = text?.length || 0;
        const indicator = theme.fg("success", "✓");

        // Show first 5 lines
        const previewLines = lines.filter((l) => l.trim()).slice(0, 5);
        const preview = previewLines
          .map((l) => `  ${theme.fg("muted", l.slice(0, 70))}`)
          .join("\n");

        // Include size info
        let info = "";
        if (size > 0) {
          info = formatSize(size);
          if (lines.length > 0) info += `, ${lines.length} lines`;
        } else if (lines.length > 0) {
          info = `${lines.length} lines`;
        }
        const summary = info ? ` ${theme.fg("muted", `(${info})`)}` : "";

        return new Text(
          ` ${indicator}${summary}${preview ? "\n" + preview : ""}`,
          0,
          0,
        );
      }

      if (!text) return new Text("", 0, 0);
      const { text: truncated, wasTruncated } = truncateOutput(text);
      const output = wasTruncated ? truncated : text;
      return new Text(`\n${theme.fg("toolOutput", output)}`, 0, 0);
    },
  });

  // Bash Tool
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Execute a bash command.",
    promptSnippet: "Execute a bash command",
    promptGuidelines: [
      "Use bash for file exploration, running tests, builds, or git operations.",
      "Prefer grep/find/ls tools over bash for file exploration when available.",
    ],
    parameters: BashParams,

    async execute(
      toolCallId,
      params: Static<typeof BashParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createBashTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args: Static<typeof BashParams>, theme, context) {
      const cmd = args.command || "...";
      const state = context.state as StreamingState | undefined;
      const indicator = state
        ? theme.fg("warning", " ● ")
        : theme.fg("dim", "⚙ ");
      return new Text(
        `${indicator}${theme.fg("toolTitle", "$")} ${theme.fg("toolOutput", cmd)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = getTextContent(result);
      const state = context.state as StreamingState | undefined;

      // While streaming, show the most recent lines dynamically
      if (isPartial && !expanded) {
        if (!state) {
          context.state = {
            outputBuffer: text,
            lastUpdateTime: Date.now(),
          } as StreamingState;
        } else {
          state.outputBuffer = text;
          state.lastUpdateTime = Date.now();
        }

        const recent = getRecentLines(text, STREAMING_PREVIEW_LINES, theme);
        const preview = theme.fg("toolOutput", recent);
        const status = theme.fg("warning", " ⟳ Running...");

        return new Text(`${status}\n${preview}`, 0, 0);
      }

      // Static result (complete or expanded) - show LAST 5 lines (final status matters)
      if (!expanded) {
        const isError = text.toLowerCase().includes("error");
        const indicator = isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");

        // Show last 5 lines (most recent output matters for bash)
        const lines = text
          .split("\n")
          .filter((l) => l.trim())
          .slice(-5);
        const preview =
          lines.length > 0
            ? "\n" +
              lines
                .map((l) => `  ${theme.fg("muted", l.slice(0, 70))}`)
                .join("\n")
            : "";
        return new Text(` ${indicator}${preview}`, 0, 0);
      }

      if (!text.trim()) return new Text("", 0, 0);
      const { text: truncated, wasTruncated } = truncateOutput(text.trim());
      const output = wasTruncated ? truncated : text.trim();
      return new Text(`\n${theme.fg("toolOutput", output)}`, 0, 0);
    },
  });

  // Write Tool
  pi.registerTool({
    name: "write",
    label: "write",
    description: "Write content to a file.",
    promptSnippet: "Write content to a file",
    promptGuidelines: [
      "Use write to create new files with full content.",
      "For modifying existing files, prefer edit over write.",
    ],
    parameters: WriteParams,

    async execute(
      toolCallId,
      params: Static<typeof WriteParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createWriteTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args: Static<typeof WriteParams>, theme) {
      const path = shortenPath(args.path || "...");
      return new Text(
        ` ${theme.fg("dim", "↓")} ${theme.fg("toolTitle", "write")} ${theme.fg("accent", path)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      if (!expanded) {
        const content = (context.args as Static<typeof WriteParams>)?.content;
        const lines = content?.split("\n").length || 0;
        const info =
          lines > 0 ? ` ${theme.fg("muted", `(${lines} lines)`)}` : "";
        return new Text(` ${theme.fg("success", "✓")}${info}`, 0, 0);
      }
      const text = getTextContent(result);
      if (text) return new Text(`\n${theme.fg("error", text)}`, 0, 0);
      return new Text("", 0, 0);
    },
  });

  // Edit Tool
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing exact text.",
    promptSnippet: "Edit a file by replacing exact text",
    promptGuidelines: [
      "Use edit for precise text replacements in existing files.",
      "The oldText must match exactly, including whitespace and indentation.",
      "Read the file first to ensure you have the correct text to replace.",
    ],
    parameters: EditParams,

    async execute(
      toolCallId,
      params: Static<typeof EditParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createEditTool(ctx.cwd);
      const transformedParams: EditInternalParams = {
        path: params.path,
        edits: [
          {
            oldText: params.oldText,
            newText: params.newText,
          },
        ],
      };
      return tool.execute(
        toolCallId,
        transformedParams as any,
        signal,
        onUpdate,
      );
    },

    renderCall(args: Static<typeof EditParams>, theme) {
      const path = shortenPath(args.path || "...");
      return new Text(
        ` ${theme.fg("dim", "✎")} ${theme.fg("toolTitle", "edit")} ${theme.fg("accent", path)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      if (!expanded) {
        const text = getTextContent(result);
        const isError = text.includes("Error");
        if (isError) return new Text(` ${theme.fg("error", "✗")}`, 0, 0);
        const args = context.args as Static<typeof EditParams>;
        const oldLines = args?.oldText?.split("\n").length || 0;
        const newLines = args?.newText?.split("\n").length || 0;
        const delta = newLines - oldLines;
        const info =
          delta !== 0
            ? ` ${theme.fg("muted", `(${delta > 0 ? "+" : ""}${delta} lines)`)}`
            : "";
        return new Text(` ${theme.fg("success", "✓")}${info}`, 0, 0);
      }
      const text = getTextContent(result);
      if (text.includes("Error"))
        return new Text(`\n${theme.fg("error", text)}`, 0, 0);
      return text
        ? new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0)
        : new Text("", 0, 0);
    },
  });

  // Find Tool
  pi.registerTool({
    name: "find",
    label: "find",
    description: "Find files by name pattern.",
    promptSnippet: "Find files by name pattern",
    promptGuidelines: [
      "Use find to locate files when you know the name or part of it.",
      "Supports glob patterns like '*.ts' or '**/config.*'.",
    ],
    parameters: FindParams,

    async execute(
      toolCallId,
      params: Static<typeof FindParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createFindTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args: Static<typeof FindParams>, theme) {
      return new Text(
        ` ${theme.fg("dim", "◎")} ${theme.fg("toolTitle", "find")} ${theme.fg("accent", args.pattern || "")}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = getTextContent(result);

      // While streaming, show files as they're discovered
      if (isPartial && !expanded) {
        const files = text.trim().split("\n").filter(Boolean);
        const recentFiles = files.slice(-3); // Last 3 files
        const fileDisplay = recentFiles
          .map((f) => `  ${theme.fg("accent", f)}`)
          .join("\n");
        const status = theme.fg("warning", ` ⟳ ${files.length} files...`);

        return new Text(`${status}\n${fileDisplay}`, 0, 0);
      }

      if (!expanded) {
        const files = text.trim().split("\n").filter(Boolean);
        const count = files.length;
        const indicator =
          count > 0
            ? theme.fg("muted", `→ ${count} files`)
            : theme.fg("success", "✓");

        // Show first 5 files
        const preview = files
          .slice(0, 5)
          .map((f) => `  ${theme.fg("accent", f)}`)
          .join("\n");
        return new Text(` ${indicator}${preview ? "\n" + preview : ""}`, 0, 0);
      }

      return text
        ? new Text(`\n${theme.fg("toolOutput", text.trim())}`, 0, 0)
        : new Text("", 0, 0);
    },
  });

  // Grep Tool
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: "Search file contents by regex.",
    promptSnippet: "Search file contents by regex",
    promptGuidelines: [
      "Use grep to search for patterns across multiple files.",
      "Supports regex patterns. Use simple strings for literal matches.",
    ],
    parameters: GrepParams,

    async execute(
      toolCallId,
      params: Static<typeof GrepParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createGrepTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args: Static<typeof GrepParams>, theme) {
      return new Text(
        ` ${theme.fg("dim", "⌕")} ${theme.fg("toolTitle", "grep")} ${theme.fg("accent", `/${args.pattern}/`)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = getTextContent(result);
      const state = context.state as StreamingState | undefined;

      // While streaming, show matches as they're found
      if (isPartial && !expanded) {
        if (!state) {
          context.state = {
            outputBuffer: text,
            lastUpdateTime: Date.now(),
          } as StreamingState;
        } else {
          state.outputBuffer = text;
          state.lastUpdateTime = Date.now();
        }

        const matches = text.trim().split("\n").filter(Boolean);
        const recentMatches = matches.slice(-3); // Last 3 matches
        const matchDisplay = recentMatches
          .map((m) => `  ${theme.fg("toolOutput", m)}`)
          .join("\n");
        const status = theme.fg("warning", ` ⟳ ${matches.length} matches...`);

        return new Text(`${status}\n${matchDisplay}`, 0, 0);
      }

      if (!expanded) {
        const matches = text.trim().split("\n").filter(Boolean);
        const count = matches.length;
        const indicator =
          count > 0
            ? theme.fg("muted", `→ ${count} matches`)
            : theme.fg("success", "✓");

        // Show first 5 matches
        const preview = matches
          .slice(0, 5)
          .map((m) => `  ${theme.fg("toolOutput", m)}`)
          .join("\n");
        return new Text(` ${indicator}${preview ? "\n" + preview : ""}`, 0, 0);
      }

      return text
        ? new Text(`\n${theme.fg("toolOutput", text.trim())}`, 0, 0)
        : new Text("", 0, 0);
    },
  });

  // Ls Tool
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: "List directory contents.",
    promptSnippet: "List directory contents",
    promptGuidelines: [
      "Use ls to explore directory structure and see what files exist.",
      "Use find instead if you need to filter by name pattern.",
    ],
    parameters: LsParams,

    async execute(
      toolCallId,
      params: Static<typeof LsParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createLsTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args: Static<typeof LsParams>, theme) {
      const path = shortenPath(args.path || ".");
      return new Text(
        ` ${theme.fg("dim", "☰")} ${theme.fg("toolTitle", "ls")} ${theme.fg("accent", path)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      if (!expanded) {
        const text = getTextContent(result);
        const count = text.trim().split("\n").filter(Boolean).length;
        return new Text(
          ` ${count > 0 ? theme.fg("muted", `→ ${count} entries`) : theme.fg("success", "✓")}`,
          0,
          0,
        );
      }
      const text = getTextContent(result);
      return text
        ? new Text(`\n${theme.fg("toolOutput", text.trim())}`, 0, 0)
        : new Text("", 0, 0);
    },
  });
}
