/**
 * Minimal Tools Extension
 * 
 * Shows compact tool indicators in the main chat:
 * - Tool call: icon + name + minimal args
 * - Tool result: just ✓ or ✗ (or count for search tools)
 * - Full output hidden until Ctrl+O expands
 */

import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

// Output truncation limits
const MAX_OUTPUT_LINES = 50;
const MAX_OUTPUT_CHARS = 10000;

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

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
	const textItem = result.content.find((c): c is TextContent => c.type === "text");
	return textItem?.text || "";
}

function truncateOutput(text: string): { text: string; wasTruncated: boolean } {
	if (text.length > MAX_OUTPUT_CHARS) {
		return { text: text.slice(0, MAX_OUTPUT_CHARS) + "\n... (truncated)", wasTruncated: true };
	}
	const lines = text.split("\n");
	if (lines.length > MAX_OUTPUT_LINES) {
		return { text: lines.slice(0, MAX_OUTPUT_LINES).join("\n") + "\n... (truncated)", wasTruncated: true };
	}
	return { text, wasTruncated: false };
}

export default function (pi: ExtensionAPI) {
	// Read Tool
	pi.registerTool({
		name: "read",
		label: "read",
		description: "Read the contents of a file.",
		parameters: ReadParams,

		async execute(toolCallId, params: Static<typeof ReadParams>, signal, onUpdate, ctx) {
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
			return new Text(` ${theme.fg("dim", "→")} ${theme.fg("toolTitle", "read")} ${theme.fg("accent", display)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) {
				const text = getTextContent(result);
				const lines = text ? text.split("\n").length : 0;
				const size = text?.length || 0;
				let info = "";
				if (size > 0) {
					const sizeStr = size < 1024 ? `${size}B` : size < 1024*1024 ? `${(size/1024).toFixed(1)}KB` : `${(size/(1024*1024)).toFixed(1)}MB`;
					info = sizeStr;
					if (lines > 0) info += `, ${lines} lines`;
				} else if (lines > 0) {
					info = `${lines} lines`;
				}
				const summary = info ? ` ${theme.fg("muted", `(${info})`)}` : "";
				return new Text(` ${theme.fg("success", "✓")}${summary}`, 0, 0);
			}
			const text = getTextContent(result);
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
		parameters: BashParams,

		async execute(toolCallId, params: Static<typeof BashParams>, signal, onUpdate, ctx) {
			const tool = createBashTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args: Static<typeof BashParams>, theme) {
			const cmd = args.command || "...";
			return new Text(` ${theme.fg("dim", "⚙")} ${theme.fg("toolTitle", "$")} ${theme.fg("toolOutput", cmd)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const text = getTextContent(result);
			if (!expanded) {
				const isError = text.toLowerCase().includes("error");
				const firstLine = text.split("\n")[0]?.slice(0, 60) || "";
				const indicator = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const preview = firstLine ? ` ${theme.fg("muted", firstLine)}` : "";
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
		parameters: WriteParams,

		async execute(toolCallId, params: Static<typeof WriteParams>, signal, onUpdate, ctx) {
			const tool = createWriteTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args: Static<typeof WriteParams>, theme) {
			const path = shortenPath(args.path || "...");
			return new Text(` ${theme.fg("dim", "↓")} ${theme.fg("toolTitle", "write")} ${theme.fg("accent", path)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			if (!expanded) {
				const content = (context.args as Static<typeof WriteParams>)?.content;
				const lines = content?.split("\n").length || 0;
				const info = lines > 0 ? ` ${theme.fg("muted", `(${lines} lines)`)}` : "";
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
		parameters: EditParams,

		async execute(toolCallId, params: Static<typeof EditParams>, signal, onUpdate, ctx) {
			const tool = createEditTool(ctx.cwd);
			const transformedParams: EditInternalParams = {
				path: params.path,
				edits: [{
					oldText: params.oldText,
					newText: params.newText
				}]
			};
			return tool.execute(toolCallId, transformedParams as any, signal, onUpdate);
		},

		renderCall(args: Static<typeof EditParams>, theme) {
			const path = shortenPath(args.path || "...");
			return new Text(` ${theme.fg("dim", "✎")} ${theme.fg("toolTitle", "edit")} ${theme.fg("accent", path)}`, 0, 0);
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
				const info = delta !== 0 ? ` ${theme.fg("muted", `(${delta > 0 ? "+" : ""}${delta} lines)`)}` : "";
				return new Text(` ${theme.fg("success", "✓")}${info}`, 0, 0);
			}
			const text = getTextContent(result);
			if (text.includes("Error")) return new Text(`\n${theme.fg("error", text)}`, 0, 0);
			return text ? new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0) : new Text("", 0, 0);
		},
	});

	// Find Tool
	pi.registerTool({
		name: "find",
		label: "find",
		description: "Find files by name pattern.",
		parameters: FindParams,

		async execute(toolCallId, params: Static<typeof FindParams>, signal, onUpdate, ctx) {
			const tool = createFindTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args: Static<typeof FindParams>, theme) {
			return new Text(` ${theme.fg("dim", "◎")} ${theme.fg("toolTitle", "find")} ${theme.fg("accent", args.pattern || "")}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) {
				const text = getTextContent(result);
				const count = text.trim().split("\n").filter(Boolean).length;
				return new Text(` ${count > 0 ? theme.fg("muted", `→ ${count} files`) : theme.fg("success", "✓")}`, 0, 0);
			}
			const text = getTextContent(result);
			return text ? new Text(`\n${theme.fg("toolOutput", text.trim())}`, 0, 0) : new Text("", 0, 0);
		},
	});

	// Grep Tool
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: "Search file contents by regex.",
		parameters: GrepParams,

		async execute(toolCallId, params: Static<typeof GrepParams>, signal, onUpdate, ctx) {
			const tool = createGrepTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args: Static<typeof GrepParams>, theme) {
			return new Text(` ${theme.fg("dim", "⌕")} ${theme.fg("toolTitle", "grep")} ${theme.fg("accent", `/${args.pattern}/`)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) {
				const text = getTextContent(result);
				const count = text.trim().split("\n").filter(Boolean).length;
				return new Text(` ${count > 0 ? theme.fg("muted", `→ ${count} matches`) : theme.fg("success", "✓")}`, 0, 0);
			}
			const text = getTextContent(result);
			return text ? new Text(`\n${theme.fg("toolOutput", text.trim())}`, 0, 0) : new Text("", 0, 0);
		},
	});

	// Ls Tool
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: "List directory contents.",
		parameters: LsParams,

		async execute(toolCallId, params: Static<typeof LsParams>, signal, onUpdate, ctx) {
			const tool = createLsTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args: Static<typeof LsParams>, theme) {
			const path = shortenPath(args.path || ".");
			return new Text(` ${theme.fg("dim", "☰")} ${theme.fg("toolTitle", "ls")} ${theme.fg("accent", path)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) {
				const text = getTextContent(result);
				const count = text.trim().split("\n").filter(Boolean).length;
				return new Text(` ${count > 0 ? theme.fg("muted", `→ ${count} entries`) : theme.fg("success", "✓")}`, 0, 0);
			}
			const text = getTextContent(result);
			return text ? new Text(`\n${theme.fg("toolOutput", text.trim())}`, 0, 0) : new Text("", 0, 0);
		},
	});
}
