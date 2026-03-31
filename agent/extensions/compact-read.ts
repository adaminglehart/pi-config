/**
 * Compact Read Extension - Shows compact summaries for all file reads
 *
 * This extension overrides the built-in `read` tool to provide compact rendering
 * for all file reads. Instead of showing full file content in the chat,
 * it shows just a summary (filename + line count + preview), while still
 * providing the full content to the LLM for processing.
 *
 * The content is collapsed by default but can be expanded with Ctrl+E
 * or by clicking on the tool result.
 *
 * Usage: automatically active when loaded via /reload or startup
 */

import type { ExtensionAPI, ReadToolDetails } from "@mariozechner/pi-coding-agent";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const originalRead = createReadTool(cwd);

	// Helper to check if a path is a SKILL.md file
	function isSkillFile(path: string): boolean {
		if (!path.endsWith("SKILL.md")) return false;

		return (
			path.includes("/.pi/agent/skills/") ||
			path.includes("/.agents/skills/") ||
			path.includes("/.pi/skills/") ||
			path.includes("/node_modules/") ||
			path.match(/[\w.-]+\/\.pi\/agent\/skills\//) !== null ||
			path.match(/[\w.-]+\/\.agents\/skills\//) !== null
		);
	}

	// Extract skill name from path
	function getSkillName(path: string): string {
		const match = path.match(/\/([^/]+)\/SKILL\.md$/);
		return match ? match[1] : "unknown";
	}

	// Extract preview from content (first line or description)
	function getPreview(path: string, content: string): string {
		// For skills, extract from frontmatter
		if (isSkillFile(path)) {
			const descMatch = content.match(/description:\s*(.+)/);
			if (descMatch) return descMatch[1].slice(0, 80);
		}

		const lines = content.split("\n");
		
		// Look for first markdown header
		const headerMatch = lines.find(l => l.startsWith("# "));
		if (headerMatch) return headerMatch.replace("# ", "").slice(0, 80);
		
		// Fall back to first non-empty line
		const firstLine = lines.find(l => l.trim());
		return firstLine ? firstLine.slice(0, 80) : "";
	}

	// Get display name for file
	function getDisplayName(path: string): string {
		if (isSkillFile(path)) {
			return `skill:${getSkillName(path)}`;
		}
		return basename(path);
	}

	pi.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			// Delegate to original implementation
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const displayName = getDisplayName(args.path);
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", displayName);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Reading..."), 0, 0);
			}

			const args = context.args as { path?: string };
			const path = args?.path || "";
			const displayName = getDisplayName(path);
			const content = result.content[0];

			if (content?.type === "image") {
				return new Text(theme.fg("success", `✓ ${displayName} (image)`), 0, 0);
			}

			if (content?.type !== "text") {
				return new Text(theme.fg("success", `✓ ${displayName}`), 0, 0);
			}

			const details = result.details as ReadToolDetails | undefined;
			const lineCount = content.text.split("\n").length;
			const preview = getPreview(path, content.text);

			// Compact display
			let text = theme.fg("success", "✓ ");
			text += theme.fg("accent", displayName);
			text += theme.fg("dim", ` (${lineCount} lines)`);
			
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}
			
			if (preview) {
				text += "\n" + theme.fg("muted", preview);
			}

			// If expanded, show first 15 lines
			if (expanded) {
				const lines = content.text.split("\n");
				const displayLines = lines.slice(0, 15);
				
				text += "\n" + theme.fg("dim", "─".repeat(40));
				for (const line of displayLines) {
					text += "\n" + theme.fg("dim", line);
				}
				if (lines.length > 15) {
					text += "\n" + theme.fg("muted", `... ${lines.length - 15} more lines`);
				}
			} else {
				text += "\n" + theme.fg("dim", "(Ctrl+E to expand)");
			}

			return new Text(text, 0, 0);
		},
	});
}
