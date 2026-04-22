/**
 * macOS Desktop Notification Extension for Pi
 *
 * Sends a native macOS notification when the agent finishes and is waiting for input,
 * but ONLY when the terminal does not have focus.
 *
 * Uses osascript - works through tmux, zellij, ssh, and any terminal setup.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import { execSync } from "child_process";

/**
 * Check if the terminal app has focus by getting the frontmost process.
 * Returns true if the terminal is focused, false otherwise.
 */
const isTerminalFocused = (): boolean => {
	try {
		const result = execSync(
			'osascript -e \'tell application "System Events" to name of (first process whose frontmost is true)\'',
			{ encoding: "utf8", timeout: 1000 }
		);
		const frontmostApp = result.trim().toLowerCase();
		const terminalApps = ["ghostty", "terminal", "iterm2", "wezterm", "alacritty", "kitty", "warp"];
		return terminalApps.some(app => frontmostApp.includes(app));
	} catch {
		return true; // Assume focused if check fails (don't notify)
	}
};

/**
 * Send a native macOS notification via osascript.
 */
const notify = (title: string, body: string): void => {
	const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
	try {
		execSync(`osascript -e '${script}'`, { timeout: 1000 });
	} catch {
		// Ignore notification failures
	}
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}
		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}
		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}
		return null;
	}
	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	const normalized = simplified.replace(/\s+/g, " ").trim();

	if (!normalized) {
		return { title: "π Ready", body: "Agent is waiting for input" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;

	return { title: "π", body };
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		// Only notify if terminal is NOT focused (user is doing something else)
		if (isTerminalFocused()) {
			return;
		}

		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText);
		notify(title, body);
	});
}
