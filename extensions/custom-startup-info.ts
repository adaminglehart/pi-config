/**
 * Custom Startup Info Extension
 *
 * Replaces the default startup resource listing (Context, Skills, Prompts, Extensions, Themes)
 * with custom information. Use `quietStartup: true` in settings to hide default listing.
 *
 * Features:
 * - Shows custom startup message with session context
 *
 * Usage:
 * Add to settings.json:
 *   "quietStartup": true,
 *   "extensions": ["~/.pi/agent/extensions/custom-startup-info.ts"]
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    // Skip startup info on reload and resume
    if (event.reason === "reload" || event.reason === "resume") return;

    await sendCustomStartupInfo(ctx);
  });

  async function sendCustomStartupInfo(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;
    const width = 45;

    // Strip ANSI escape codes to get visual width
    const stripAnsi = (str: string): string =>
      str.replace(/\u001b\[[0-9;]*m/g, "");

    // Helper functions for styling
    const t = {
      accent: (text: string) => theme.fg("accent", text),
      muted: (text: string) => theme.fg("muted", text),
      dim: (text: string) => theme.fg("dim", text),
      text: (text: string) => theme.fg("text", text),
      bold: (text: string) => theme.bold(text),
    };

    const box = {
      top: () =>
        `${t.accent("╭")}${t.muted("─".repeat(width))}${t.accent("╮")}`,
      bottom: () =>
        `${t.accent("╰")}${t.muted("─".repeat(width))}${t.accent("╯")}`,
      line: (content: string, align: "left" | "center" | "right" = "left") => {
        const contentWidth = width;
        const visualLen = stripAnsi(content).length;
        const padLeft = Math.max(
          0,
          align === "center"
            ? Math.floor((contentWidth - visualLen) / 2)
            : align === "right"
              ? contentWidth - visualLen
              : 0,
        );
        const padRight = Math.max(0, contentWidth - visualLen - padLeft);
        return `${t.accent("│")}${" ".repeat(padLeft)}${content}${" ".repeat(padRight)}${t.accent("│")}`;
      },
    };

    const lines: string[] = [];

    // Header
    lines.push(box.top());
    lines.push(box.line(`${t.dim("new session")}`, "center"));
    lines.push();
    lines.push(box.line(`remember to start /acm`, "center"));
    lines.push(box.bottom());

    // Print directly to console - not persisted in session
    console.log("\n" + lines.join("\n") + "\n");
  }
}
