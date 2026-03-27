/**
 * Custom Footer - Shows model info, costs, and status in a powerline-style footer
 *
 * Displays:
 * - Model info (Line 1 & 2)
 * - Dynamic height Status Box (right)
 * - Dynamic Scene (Bottom rows)
 *
 * Usage: pi -e ./custom-footer/index.ts
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionMessageEntry,
  Theme,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";
import {
  renderAnimationBlock,
  startAnimation,
  stopAnimation,
  cycleAnimation,
  cycleScene,
  getActiveScene,
  setAgentState,
  CONFIG,
} from "./animation.js";

// ═══════════════════════════════════════════════════════════════════════════
// Color helpers
// ═══════════════════════════════════════════════════════════════════════════

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  fg: (color: string) => `\x1b[38;5;${color}m`,
};

export const colors = {
  pi: "213", // Pink
  model: "183", // Light purple
  input: "111", // Light blue
  output: "158", // Light green
  cost: "222", // Light yellow
  thinking: "183", // Light purple
  sep: "240", // Gray
  text: "250", // Light gray
  accent: "213", // Pink
};

// ═══════════════════════════════════════════════════════════════════════════
// Formatting helpers
// ═══════════════════════════════════════════════════════════════════════════

function formatCost(cost: number): string {
  if (cost === 0) return "free";
  if (cost < 0.01) return `${(cost * 100).toFixed(2)}¢`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1000000) {
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
  }
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function getThinkingEmoji(level: string): string {
  switch (level) {
    case "off":
      return "○";
    case "minimal":
      return "◐";
    case "low":
      return "◑";
    case "medium":
      return "◒";
    case "high":
      return "◓";
    case "xhigh":
      return "●";
    default:
      return "○";
  }
}

function getThinkingLabel(level: string): string {
  switch (level) {
    case "off":
      return "off";
    case "minimal":
      return "min";
    case "low":
      return "low";
    case "medium":
      return "med";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return level;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment renderers
// ═══════════════════════════════════════════════════════════════════════════

interface FooterContext {
  model: Model<Api> | null;
  thinkingLevel: string;
  usageCost: number;
  contextTokens: number | null;
  contextPercent: number | null;
  contextWindow: number;
  cwd: string;
  gitBranch: string | null;
  acmEnabled: boolean;
  extensionStatuses: ReadonlyMap<string, string>;
}

function renderAcmSegment(ctx: FooterContext): string {
  if (ctx.acmEnabled) {
    return `${ansi.fg(colors.pi)}ACM${ansi.reset}`;
  } else {
    return `${ansi.fg(colors.sep)}ACM:${ansi.reset}${ansi.fg(colors.text)}off${ansi.reset}`;
  }
}

function renderModelSegment(ctx: FooterContext): string {
  if (!ctx.model) return "";
  const modelName = ctx.model.name || ctx.model.id;
  let shortName = modelName.trim();
  if (shortName.startsWith("Claude ")) shortName = shortName.slice(7);
  if (shortName.startsWith("Google: ")) shortName = shortName.slice(8);
  if (shortName.startsWith("MoonshotAI: ")) shortName = shortName.slice(11);
  if (shortName.startsWith("Anthropic: ")) shortName = shortName.slice(10);
  if (shortName.startsWith("OpenAI: ")) shortName = shortName.slice(8);
  if (shortName.length > 30) shortName = shortName.slice(0, 30) + "…";
  return `${ansi.fg(colors.model)}${shortName}${ansi.reset}`;
}

function renderPricingSegment(ctx: FooterContext): string {
  if (!ctx.model) return "";
  const { cost } = ctx.model;
  const inPrice = formatCost(cost.input);
  const outPrice = formatCost(cost.output);
  const inColor = ansi.fg(colors.input);
  const outColor = ansi.fg(colors.output);
  const sepColor = ansi.fg(colors.sep);
  return `${inColor}▲${inPrice}${ansi.reset}${sepColor}/${ansi.reset}${outColor}▼${outPrice}${ansi.reset}`;
}

function renderThinkingSegment(ctx: FooterContext): string {
  const level = ctx.thinkingLevel || "off";
  const emoji = getThinkingEmoji(level);
  const label = getThinkingLabel(level);
  return `${ansi.fg(colors.thinking)}${emoji}${ansi.reset} ${ansi.fg(colors.text)}${label}${ansi.reset}`;
}

function renderDirectorySegment(ctx: FooterContext): string {
  if (!ctx.cwd) return "";
  const color = ansi.fg(colors.text);
  let displayPath = ctx.cwd;
  const home = "/Users/adaminglehart";
  if (displayPath.startsWith(home))
    displayPath = "~" + displayPath.slice(home.length);
  return `${color}${displayPath}${ansi.reset}`;
}

function renderBranchSegment(ctx: FooterContext): string {
  if (!ctx.gitBranch) return "";
  const branch = ctx.gitBranch === "detached" ? "◆" : ctx.gitBranch;
  return `${ansi.fg(colors.text)}${ansi.reset}${ansi.fg(colors.model)}${branch}${ansi.reset}`;
}

function renderTokensSegment(ctx: FooterContext): string {
  if (ctx.contextWindow <= 0) return "";
  const inColor = ansi.fg(colors.input);
  const textColor = ansi.fg(colors.text);
  const dimColor = ansi.fg(colors.sep);
  let display =
    ctx.contextPercent !== null
      ? `${Math.round(ctx.contextPercent * 10) / 10}%`
      : `${dimColor}?${ansi.reset}${inColor}`;
  display += `/${formatTokens(ctx.contextWindow)}`;
  return `${textColor}ctx:${ansi.reset} ${inColor}${display}${ansi.reset}`;
}

function renderSessionCostSegment(ctx: FooterContext): string {
  return `${ansi.fg(colors.text)}cost:${ansi.reset} ${ansi.fg(colors.cost)}$${ctx.usageCost.toFixed(3)}${ansi.reset}`;
}

function renderExtensionStatuses(ctx: FooterContext): string {
  if (ctx.extensionStatuses.size === 0) return "";
  const parts: string[] = [];
  for (const [, text] of ctx.extensionStatuses) {
    if (text) parts.push(text);
  }
  return parts.join(` ${ansi.fg(colors.sep)}│${ansi.reset} `);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main footer builder
// ═══════════════════════════════════════════════════════════════════════════

function buildFooter(ctx: FooterContext, width: number): string[] {
  const separator = ` ${ansi.fg(colors.sep)}│${ansi.reset} `;
  const sepColor = ansi.fg(colors.sep);
  const reset = ansi.reset;

  const scene = getActiveScene();

  // Total height = 2 info lines + scene top border + scene rows + scene bottom border
  const totalHeight = 2 + 1 + scene.height + 1;
  const animLines = renderAnimationBlock(totalHeight);

  const animWidth = CONFIG.BOX_WIDTH;
  const mainWidth = width - animWidth - 2;

  // Scene box inner width (subtract 2 for left/right borders)
  const sceneInnerWidth = mainWidth - 2;

  // Line 1 Content: directory and branch
  const line1Segments: string[] = [];
  const dirSeg = renderDirectorySegment(ctx);
  const branchSeg = renderBranchSegment(ctx);
  if (dirSeg) line1Segments.push(dirSeg);
  if (branchSeg) line1Segments.push(branchSeg);
  const line1Content = line1Segments.join(separator);

  // Line 2 Content: model, thinking, ACM, tokens, cost, extension statuses
  const line2Segments: string[] = [];
  const modelSeg = renderModelSegment(ctx);
  const pricingSeg = renderPricingSegment(ctx);
  const thinkingSeg = renderThinkingSegment(ctx);
  const tokensSeg = renderTokensSegment(ctx);
  const costSeg = renderSessionCostSegment(ctx);
  const acmSeg = renderAcmSegment(ctx);
  const extStatusSeg = renderExtensionStatuses(ctx);
  if (modelSeg) line2Segments.push(modelSeg);
  if (pricingSeg) line2Segments.push(pricingSeg);
  if (thinkingSeg) line2Segments.push(thinkingSeg);
  if (tokensSeg) line2Segments.push(tokensSeg);
  if (costSeg) line2Segments.push(costSeg);
  if (acmSeg) line2Segments.push(acmSeg);
  if (extStatusSeg) line2Segments.push(extStatusSeg);
  const line2Content = line2Segments.join(separator);

  // Scene content (rendered into the inner width)
  const sceneLines = scene.render(sceneInnerWidth, ctx.contextPercent || 0);

  // Padding
  const line1Pad = Math.max(0, mainWidth - visibleWidth(line1Content));
  const line2Pad = Math.max(0, mainWidth - visibleWidth(line2Content));

  // Build the final array of lines
  const resultLines: string[] = [];
  let animIdx = 0;

  // Info Line 1
  resultLines.push(
    truncateToWidth(
      line1Content + " ".repeat(line1Pad) + "  " + animLines[animIdx++],
      width,
    ),
  );

  // Info Line 2
  resultLines.push(
    truncateToWidth(
      line2Content + " ".repeat(line2Pad) + "  " + animLines[animIdx++],
      width,
    ),
  );

  // Scene top border
  const sceneTopBorder = `${sepColor}┌${"─".repeat(sceneInnerWidth)}┐${reset}`;
  resultLines.push(
    truncateToWidth(
      sceneTopBorder + "  " + animLines[animIdx++],
      width,
    ),
  );

  // Scene content rows with side borders
  for (let i = 0; i < sceneLines.length; i++) {
    const content = sceneLines[i] || " ".repeat(sceneInnerWidth);
    const contentPad = Math.max(0, sceneInnerWidth - visibleWidth(content));
    const borderedRow = `${sepColor}│${reset}${content}${" ".repeat(contentPad)}${sepColor}│${reset}`;
    resultLines.push(
      truncateToWidth(
        borderedRow + "  " + (animLines[animIdx++] || ""),
        width,
      ),
    );
  }

  // Scene bottom border
  const sceneBottomBorder = `${sepColor}└${"─".repeat(sceneInnerWidth)}┘${reset}`;
  resultLines.push(
    truncateToWidth(
      sceneBottomBorder + "  " + (animLines[animIdx] || ""),
      width,
    ),
  );

  return resultLines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function customFooter(pi: ExtensionAPI) {
  let enabled = true;
  let tuiRef: TUI | null = null;
  let ctxRef: ExtensionContext | null = null;
  let acmEnabled = false;

  pi.events.on("context-pilot:enabled", () => {
    acmEnabled = true;
    tuiRef?.requestRender();
  });

  pi.on("agent_end", async () => {
    setAgentState("paused");
    tuiRef?.requestRender();
  });
  pi.on("model_select", async () => {
    tuiRef?.requestRender();
  });
  pi.on("agent_start", async () => {
    setAgentState("thinking");
    tuiRef?.requestRender();
  });

  // Track when agent is actively working (tools being called)
  pi.on("tool_execution_start", async () => {
    setAgentState("active");
    tuiRef?.requestRender();
  });
  pi.on("tool_execution_end", async () => {
    setAgentState("thinking");
    tuiRef?.requestRender();
  });

  pi.on("session_switch", async () => {
    setAgentState("paused");
    acmEnabled = false;
    pi.events.emit("context-pilot:status_request", {});
    tuiRef?.requestRender();
  });

  pi.registerCommand("footer-cycle", {
    description: "Cycle footer animation style",
    handler: async (_args, ctx) => {
      const style = cycleAnimation();
      ctx.ui.notify(`Style: ${style}`, "info");
      tuiRef?.requestRender();
    },
  });

  pi.registerCommand("footer-scene", {
    description: "Cycle footer scene",
    handler: async (_args, ctx) => {
      const scene = cycleScene();
      ctx.ui.notify(`Scene: ${scene}`, "info");
      tuiRef?.requestRender();
    },
  });

  pi.registerCommand("fish", {
    description: "Interact with the current scene",
    handler: async (_args, ctx) => {
      const scene = getActiveScene();
      if (scene.onCommand) {
        scene.onCommand(ctx);
        ctx.ui.notify("Interacted with scene! ✨", "info");
      } else {
        ctx.ui.notify("Active scene has no interaction.", "warning");
      }
      tuiRef?.requestRender();
    },
  });

  pi.registerCommand("footer", {
    description: "Toggle custom footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) {
        setupFooter(ctx);
        ctx.ui.notify("Footer enabled", "info");
      } else {
        stopAnimation();
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Footer disabled", "info");
      }
    },
  });

  function calculateSessionCost(ctx: ExtensionContext): number {
    let total = 0;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message") continue;
        const msg = (entry as SessionMessageEntry).message;
        if (msg.role === "assistant" && msg.usage?.cost?.total) {
          total += msg.usage.cost.total;
        }
      }
    } catch {}
    return total;
  }

  function setupFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctxRef = ctx;
    ctx.ui.setFooter(
      (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        tuiRef = tui;
        return {
          render: (width: number): string[] => {
            const contextUsage = ctxRef?.getContextUsage?.();
            const footerContext: FooterContext = {
              model: ctxRef?.model ?? null,
              thinkingLevel: pi.getThinkingLevel(),
              usageCost: ctxRef ? calculateSessionCost(ctxRef) : 0,
              contextTokens: contextUsage?.tokens ?? null,
              contextPercent: contextUsage?.percent ?? null,
              contextWindow: contextUsage?.contextWindow ?? 0,
              cwd: ctxRef?.cwd ?? "",
              gitBranch: footerData?.getGitBranch?.() ?? null,
              acmEnabled: acmEnabled,
              extensionStatuses:
                footerData?.getExtensionStatuses?.() ?? new Map(),
            };
            return buildFooter(footerContext, width);
          },
          invalidate: () => {},
          dispose: () => {
            stopAnimation();
          },
        };
      },
    );
    startAnimation(tuiRef);
  }

  pi.on("session_start", async (_event, ctx) => {
    pi.events.emit("context-pilot:status_request", {});
    if (enabled && ctx.hasUI) setupFooter(ctx);
  });
}
