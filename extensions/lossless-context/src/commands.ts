/**
 * LCM slash command registration.
 * Provides /lcm (status), /lcm context, /lcm backup, /lcm doctor, /lcm doctor fix, /lcm rotate.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import type { LcmDatabase } from "./db/connection.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { ContextItemsStore } from "./store/context-items-store.js";
import type { IntegrityChecker } from "./integrity.js";
import type { LargeFileStore } from "./large-files.js";
import type { ContextAssembler } from "./assembler.js";
import type { CompactionEngine } from "./compaction.js";
import type { ConversationRecord, LcmConfig } from "./types.js";
import { stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CommandDeps {
  getDatabase: () => LcmDatabase | undefined;
  getConversationStore: () => ConversationStore | undefined;
  getSummaryStore: () => SummaryStore | undefined;
  getContextItemsStore: () => ContextItemsStore | undefined;
  getIntegrityChecker: () => IntegrityChecker | undefined;
  getLargeFileStore: () => LargeFileStore | undefined;
  getAssembler: () => ContextAssembler | undefined;
  getCompactionEngine: () => CompactionEngine | undefined;
  getConversation: () => ConversationRecord | undefined;
  getConfig: () => LcmConfig;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("lcm", {
    description:
      "LCM: status overview. Subcommands: context, recompact, backup, doctor, doctor fix, rotate",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args?.trim() ?? "";

      if (sub === "context") return handleContext(deps, ctx);
      if (sub === "recompact") return handleRecompact(deps, ctx);
      if (sub === "backup") return handleBackup(deps, ctx);
      if (sub === "doctor fix") return handleDoctor(deps, ctx, true);
      if (sub === "doctor") return handleDoctor(deps, ctx, false);
      if (sub === "rotate") return handleRotate(deps, ctx);

      return handleStatus(deps, ctx);
    },
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleStatus(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const db = deps.getDatabase();
  const conv = deps.getConversation();
  const summaryStore = deps.getSummaryStore();
  const convStore = deps.getConversationStore();
  const config = deps.getConfig();

  if (!db || !conv || !summaryStore || !convStore) {
    ctx.ui.notify("LCM not initialized", "error");
    return;
  }

  const counts = summaryStore.getSummaryCounts(conv.id);
  const messageCount = convStore.getMessageCount(conv.id);
  const contextItems =
    deps.getContextItemsStore()?.getContextItems(conv.id) ?? [];
  const largeFileStore = deps.getLargeFileStore();
  const largeFileStats = largeFileStore && conv
    ? largeFileStore.getLargeFileStats(conv.id)
    : { count: 0, totalTokens: 0 };

  let dbSize = "unknown";
  try {
    const s = await stat(db.getPath());
    dbSize = formatBytes(s.size);
  } catch {
    // best-effort
  }

  // Count context item types
  let ctxMessages = 0;
  let ctxSummaries = 0;
  for (const item of contextItems) {
    if (item.item_type === "message") ctxMessages++;
    else ctxSummaries++;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(" 📚 LCM Status")), 1, 0));
    container.addChild(new Spacer(1));

    // Database section
    container.addChild(new Text(theme.fg("accent", theme.bold("  Database")), 0, 0));
    container.addChild(new Text(`    Path    ${theme.fg("text", db.getPath())}`, 0, 0));
    container.addChild(new Text(`    Size    ${theme.fg("text", dbSize)}`, 0, 0));
    container.addChild(new Text(`    FTS5    ${db.hasFts5 ? theme.fg("success", "✓ enabled") : theme.fg("error", "✗ unavailable")}`, 0, 0));
    container.addChild(new Spacer(1));

    // Conversation section
    container.addChild(new Text(theme.fg("accent", theme.bold("  Conversation")), 0, 0));
    container.addChild(new Text(`    Session ${theme.fg("text", conv.session_key)}`, 0, 0));
    container.addChild(new Text(`    ID      ${theme.fg("dim", conv.id)}`, 0, 0));
    container.addChild(new Spacer(1));

    // Data section
    container.addChild(new Text(theme.fg("accent", theme.bold("  Data")), 0, 0));
    container.addChild(new Text(`    Raw messages        ${theme.fg("text", String(messageCount))}`, 0, 0));
    container.addChild(new Text(`    Leaf summaries      ${theme.fg("text", String(counts.leaf))}`, 0, 0));
    container.addChild(new Text(`    Condensed summaries ${theme.fg("text", String(counts.condensed))}`, 0, 0));
    container.addChild(new Text(`    Large files         ${theme.fg("text", String(largeFileStats.count))}`, 0, 0));
    container.addChild(new Spacer(1));

    // Context items section
    container.addChild(new Text(theme.fg("accent", theme.bold("  Active Context")), 0, 0));
    container.addChild(new Text(`    Total items         ${theme.fg("text", String(contextItems.length))}`, 0, 0));
    container.addChild(new Text(`    Messages            ${theme.fg("text", String(ctxMessages))}`, 0, 0));
    container.addChild(new Text(`    Summaries           ${theme.fg("text", String(ctxSummaries))}`, 0, 0));
    container.addChild(new Spacer(1));

    // Config section
    container.addChild(new Text(theme.fg("accent", theme.bold("  Configuration")), 0, 0));
    container.addChild(new Text(`    Model               ${theme.fg("text", `${config.summaryProvider}/${config.summaryModel}`)}`, 0, 0));
    container.addChild(new Text(`    Assembly budget     ${theme.fg("text", String(config.contextThreshold))}`, 0, 0));
    container.addChild(new Text(`    Fresh tail count    ${theme.fg("text", String(config.freshTailCount))}`, 0, 0));
    container.addChild(new Text(`    Leaf chunk tokens   ${theme.fg("text", String(config.leafChunkTokens))}`, 0, 0));
    container.addChild(new Text(`    Max depth           ${theme.fg("text", String(config.incrementalMaxDepth))}`, 0, 0));
    container.addChild(new Spacer(1));

    // Commands help
    container.addChild(new Text(theme.fg("accent", theme.bold("  Commands")), 0, 0));
    container.addChild(new Text(`    ${theme.fg("text", "/lcm backup")}      ${theme.fg("dim", "Create timestamped DB backup")}`, 0, 0));
    container.addChild(new Text(`    ${theme.fg("text", "/lcm doctor")}      ${theme.fg("dim", "Check DAG integrity")}`, 0, 0));
    container.addChild(new Text(`    ${theme.fg("text", "/lcm doctor fix")}  ${theme.fg("dim", "Check and repair DAG issues")}`, 0, 0));
    container.addChild(new Text(`    ${theme.fg("text", "/lcm rotate")}      ${theme.fg("dim", "Force-compact raw messages")}`, 0, 0));
    container.addChild(new Spacer(1));

    container.addChild(new Text(theme.fg("dim", "  Press any key to close"), 0, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (_data: string) => done(undefined),
    };
  }, { overlay: true });
}

async function handleContext(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const conv = deps.getConversation();
  const summaryStore = deps.getSummaryStore();
  const contextItemsStore = deps.getContextItemsStore();
  const assembler = deps.getAssembler();
  const config = deps.getConfig();

  if (!conv || !summaryStore || !contextItemsStore || !assembler) {
    ctx.ui.notify("LCM not initialized", "error");
    return;
  }

  const counts = summaryStore.getSummaryCounts(conv.id);
  const contextItems = contextItemsStore.getContextItems(conv.id);
  const tokenBudget = ctx.model?.contextWindow ?? 200000;
  const summaryMessages = assembler.assembleSummariesOnly(conv.id, tokenBudget);

  let ctxMessages = 0;
  let ctxSummaries = 0;
  for (const item of contextItems) {
    if (item.item_type === "message") ctxMessages++;
    else ctxSummaries++;
  }

  const allSummaries = summaryStore.getAllSummaries(conv.id);

  let injectedText = "(none — no summaries to inject)";
  if (summaryMessages.length > 0) {
    const msg = summaryMessages[0];
    if (typeof msg.content === "string") {
      injectedText = msg.content;
    } else if (Array.isArray(msg.content)) {
      injectedText = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }

  // Build plain-text output
  const lines: string[] = [];
  lines.push("# LCM Context Inspector");
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(`- Context items: ${contextItems.length} (${ctxSummaries} summaries + ${ctxMessages} messages)`);
  lines.push(`- Summaries in DB: ${counts.total} (${counts.leaf} leaf, ${counts.condensed} condensed)`);
  lines.push(`- Injected messages: ${summaryMessages.length}`);
  lines.push(`- Token budget: ${tokenBudget.toLocaleString()} (assembly budget fraction: ${config.contextThreshold})`);
  lines.push(`- Fresh tail count: ${config.freshTailCount}`);
  lines.push("");

  lines.push("## Summaries");
  lines.push("");
  if (allSummaries.length === 0) {
    lines.push("(no summaries yet)");
  } else {
    for (const summary of allSummaries) {
      lines.push(`### [${summary.kind} d=${summary.depth}] ${summary.id}`);
      lines.push(`${summary.token_count} tokens · ${summary.created_at}`);
      lines.push("");
      lines.push(summary.content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  lines.push("## Injected into Context");
  lines.push("(this is the exact content prepended to the LLM's message list)");
  lines.push("");
  lines.push(injectedText);

  const outPath = join(homedir(), ".pi", "lcm-context.md");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  ctx.ui.notify(`Written to ${outPath}`, "info");
}

async function handleRecompact(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const conv = deps.getConversation();
  const engine = deps.getCompactionEngine();
  const summaryStore = deps.getSummaryStore();
  const contextItemsStore = deps.getContextItemsStore();

  if (!conv || !engine || !summaryStore || !contextItemsStore) {
    ctx.ui.notify("LCM not initialized", "error");
    return;
  }

  ctx.ui.notify("Clearing summaries and rebuilding context items...", "info");

  try {
    // Clear all existing summaries
    summaryStore.clearConversationSummaries(conv.id);

    // Rebuild context items from all messages
    contextItemsStore.rebuildFromMessages(conv.id);

    // Run fresh compaction
    await engine.runCompaction(conv.id);

    const counts = summaryStore.getSummaryCounts(conv.id);
    ctx.ui.notify(
      `Recompaction complete: ${counts.total} summaries (${counts.leaf} leaf, ${counts.condensed} condensed)`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`Recompaction failed: ${error}`, "error");
  }
}

async function handleBackup(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const db = deps.getDatabase();
  if (!db) {
    ctx.ui.notify("LCM not initialized", "error");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(homedir(), ".pi", "lcm-backups");
  const backupPath = join(backupDir, `lcm-${timestamp}.db`);

  try {
    mkdirSync(backupDir, { recursive: true });

    // VACUUM INTO creates a consistent, compacted copy
    db.db.exec(`VACUUM INTO '${backupPath}'`);

    const s = await stat(backupPath);
    ctx.ui.notify(
      `✅ Backup created: ${backupPath} (${formatBytes(s.size)})`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `❌ Backup failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function handleDoctor(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
  fix: boolean,
): Promise<void> {
  const checker = deps.getIntegrityChecker();
  if (!checker) {
    ctx.ui.notify("LCM not initialized", "error");
    return;
  }

  const report = checker.check();

  const lines = [
    "## LCM Doctor",
    "",
    `**Status:** ${report.healthy ? "✅ Healthy" : "⚠️ Issues found"}`,
    "",
    "### Database Stats",
    `- Conversations: ${report.stats.conversations}`,
    `- Messages: ${report.stats.messages}`,
    `- Summaries: ${report.stats.summaries}`,
    `- Context items: ${report.stats.contextItems}`,
    `- Large files: ${report.stats.largeFiles}`,
  ];

  if (report.issues.length > 0) {
    lines.push("", `### Issues (${report.issues.length})`);
    for (const issue of report.issues) {
      const icon = issue.severity === "error" ? "🔴" : "🟡";
      lines.push(`${icon} [${issue.type}] ${issue.description}`);
    }

    if (fix) {
      const fixCount = checker.repair();
      lines.push("", "### Repair", `✅ Applied ${fixCount} fixes`);
    } else {
      lines.push("", "*Run `/lcm doctor fix` to repair*");
    }
  } else {
    lines.push("", "No issues found.");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleRotate(
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const conv = deps.getConversation();
  const engine = deps.getCompactionEngine();
  const summaryStore = deps.getSummaryStore();

  if (!conv || !engine || !summaryStore) {
    ctx.ui.notify("LCM not initialized", "error");
    return;
  }

  ctx.ui.notify("🔄 Rotating: force-compacting all raw messages...", "info");

  try {
    const beforeCounts = summaryStore.getSummaryCounts(conv.id);

    await engine.runCompaction(conv.id);

    const afterCounts = summaryStore.getSummaryCounts(conv.id);

    ctx.ui.notify(
      `✅ Rotate complete: ${beforeCounts.total} → ${afterCounts.total} summaries ` +
        `(${afterCounts.leaf} leaf, ${afterCounts.condensed} condensed)`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `❌ Rotate failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
