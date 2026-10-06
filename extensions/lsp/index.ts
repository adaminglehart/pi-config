/**
 * LSP Extension for pi-coding-agent
 *
 * Provides:
 * - `lsp` tool for workspace symbols, definitions, references, implementations,
 *   call hierarchy, hover, symbols, diagnostics, rename, code actions
 * - Auto-diagnostics hook after file edits (configurable mode)
 * - `/lsp` command for settings
 * - Status bar integration
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Diagnostic } from "vscode-languageserver-protocol";
import {
  getOrCreateManager,
  shutdownManager,
  formatDiagnostic,
  diagnosticMessageText,
  filterDiagnosticsBySeverity,
  resolvePosition,
  collectSymbols,
  type SeverityFilter,
  type LSPManager,
} from "./lsp-core.js";
import { LSP_SERVERS, WARMUP_MAP } from "./lsp-servers.js";
import { editHeaderPaths, editedPathsFromDetails } from "./lsp-edit-paths.js";
import {
  runCallsAction,
  runLocationAction,
  runRenameAction,
  runWorkspaceSymbolsAction,
} from "./lsp-navigation-actions.js";
import { getNamespacedConfig, setNamespacedConfig } from "../_lib/settings.js";

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

const DIAGNOSTICS_WAIT_MS_DEFAULT = 3000;
const DIAGNOSTICS_PREVIEW_LINES = 10;
const LSP_IDLE_SHUTDOWN_MS = 2 * 60 * 1000;
const SETTINGS_NAMESPACE = "lsp";
const LSP_CONFIG_ENTRY = "lsp-hook-config";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

type HookMode = "edit_write" | "agent_end" | "disabled";
type HookScope = "session" | "global";

interface HookConfigEntry {
  scope: HookScope;
  hookMode?: HookMode;
}

const MODE_LABELS: Record<HookMode, string> = {
  edit_write: "After each edit/write",
  agent_end: "At agent end",
  disabled: "Disabled",
};

// -------------------------------------------------------------------
// Tool parameters
// -------------------------------------------------------------------

const ACTIONS = [
  "workspace-symbols",
  "definition",
  "type-definition",
  "implementation",
  "references",
  "incoming-calls",
  "outgoing-calls",
  "hover",
  "symbols",
  "diagnostics",
  "workspace-diagnostics",
  "signature",
  "rename",
  "codeAction",
] as const;

type LspAction = (typeof ACTIONS)[number];

const POSITION_ACTIONS: ReadonlySet<LspAction> = new Set([
  "definition",
  "type-definition",
  "implementation",
  "references",
  "incoming-calls",
  "outgoing-calls",
  "hover",
  "signature",
  "rename",
  "codeAction",
]);

const SEVERITY_FILTERS = ["all", "error", "warning", "info", "hint"] as const;

const LspParams = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.Optional(
    Type.String({
      description:
        "File path. Required for all actions except workspace-diagnostics and workspace-symbols (for workspace-symbols it selects the project).",
    }),
  ),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description: "File paths for workspace-diagnostics",
    }),
  ),
  line: Type.Optional(
    Type.Number({
      description:
        "Line (1-indexed). Required for position-based actions unless query provided.",
    }),
  ),
  column: Type.Optional(
    Type.Number({
      description:
        "Column (1-indexed). Required for position-based actions unless query provided.",
    }),
  ),
  endLine: Type.Optional(
    Type.Number({
      description: "End line for range-based actions (codeAction)",
    }),
  ),
  endColumn: Type.Optional(
    Type.Number({
      description: "End column for range-based actions (codeAction)",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Symbol name to search (workspace-symbols, symbols), or identifier name that sets the position in file for position actions",
    }),
  ),
  newName: Type.Optional(
    Type.String({ description: "New name for rename action" }),
  ),
  severity: Type.Optional(
    StringEnum(SEVERITY_FILTERS, {
      description: 'Filter diagnostics: "all"|"error"|"warning"|"info"|"hint"',
    }),
  ),
});

type LspParamsType = Static<typeof LspParams>;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function diagnosticsWaitMsForFile(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".kt" || ext === ".kts") return 30_000;
  if (ext === ".swift") return 20_000;
  if (ext === ".rs") return 20_000;
  return DIAGNOSTICS_WAIT_MS_DEFAULT;
}

function normalizeHookMode(value: unknown): HookMode | undefined {
  if (value === "edit_write" || value === "agent_end" || value === "disabled") {
    return value;
  }
  return undefined;
}


function formatHover(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) =>
        typeof c === "string" ? c : ((c as { value?: string })?.value ?? ""),
      )
      .filter(Boolean)
      .join("\n\n");
  }
  if (contents && typeof contents === "object" && "value" in contents) {
    return String((contents as { value: unknown }).value);
  }
  return "";
}

function formatSignature(help: SignatureHelp | null): string {
  if (!help?.signatures?.length) return "No signature help available.";
  const sig = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  let text = sig.label ?? "Signature";
  if (sig.documentation) {
    text += `\n${typeof sig.documentation === "string" ? sig.documentation : ((sig.documentation as { value?: string })?.value ?? "")}`;
  }
  return text;
}


function formatCodeActions(actions: (CodeAction | Command)[]): string[] {
  return actions.map((a, i) => {
    const title = "title" in a ? a.title : "Untitled action";
    const kind = "kind" in a && a.kind ? ` (${a.kind})` : "";
    const isPreferred = "isPreferred" in a && a.isPreferred ? " ★" : "";
    return `${i + 1}. ${title}${kind}${isPreferred}`;
  });
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "text"
          ? String((item as { text?: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

import type {
  SignatureHelp,
  CodeAction,
  Command,
} from "vscode-languageserver-protocol";

// -------------------------------------------------------------------
// Extension entry point
// -------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------
  // State
  // -----------------------------------------------------------------

  const activeClients = new Set<string>();
  let statusUi: ExtensionContext["ui"] | null = null;
  let hookMode: HookMode = "agent_end";
  let hookScope: HookScope = "global";
  let diagnosticsAbort: AbortController | null = null;
  let shuttingDown = false;
  let idleShutdownTimer: NodeJS.Timeout | null = null;

  const touchedFiles = new Map<string, boolean>();

  // -----------------------------------------------------------------
  // Settings persistence
  // -----------------------------------------------------------------

  function getGlobalHookMode(): HookMode | undefined {
    const { hookMode } = getNamespacedConfig(SETTINGS_NAMESPACE, {
      hookMode: "",
    });
    return normalizeHookMode(hookMode);
  }

  function setGlobalHookMode(mode: HookMode): boolean {
    return setNamespacedConfig(SETTINGS_NAMESPACE, { hookMode: mode });
  }

  function restoreHookState(ctx: ExtensionContext): void {
    // Check session-level entries first
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === LSP_CONFIG_ENTRY) {
        const data = entry.data as HookConfigEntry | undefined;
        if (data?.scope === "session") {
          const normalized = normalizeHookMode(data.hookMode);
          if (normalized) {
            hookMode = normalized;
            hookScope = "session";
            return;
          }
        }
      }
    }

    const globalSetting = getGlobalHookMode();
    hookMode = globalSetting ?? "agent_end";
    hookScope = "global";
  }

  // -----------------------------------------------------------------
  // Status bar
  // -----------------------------------------------------------------

  function updateLspStatus(): void {
    if (!statusUi) return;
    const { theme } = statusUi;

    const clients = activeClients.size > 0 ? [...activeClients].join(", ") : "";
    const clientsText = clients ? theme.fg("dim", `(${clients})`) : "";

    if (hookMode === "disabled") {
      const text = `${theme.fg("warning", "LSP")} ${theme.fg("dim", "(tool)")}`;
      statusUi.setStatus("lsp", clientsText ? `${text}: ${clientsText}` : text);
      return;
    }

    let text = theme.fg("success", "LSP");
    if (clientsText) text += ` ${clientsText}`;
    statusUi.setStatus("lsp", text);
  }

  // -----------------------------------------------------------------
  // Idle shutdown
  // -----------------------------------------------------------------

  function clearIdleShutdownTimer(): void {
    if (!idleShutdownTimer) return;
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }

  function scheduleIdleShutdown(): void {
    clearIdleShutdownTimer();
    idleShutdownTimer = setTimeout(() => {
      idleShutdownTimer = null;
      if (shuttingDown) return;
      diagnosticsAbort?.abort();
      diagnosticsAbort = null;
      shutdownManager().then(() => {
        activeClients.clear();
        updateLspStatus();
      });
    }, LSP_IDLE_SHUTDOWN_MS);
    (idleShutdownTimer as NodeJS.Timeout).unref?.();
  }

  // -----------------------------------------------------------------
  // File tracking helpers
  // -----------------------------------------------------------------

  function normalizeFilePath(filePath: string, cwd: string): string {
    return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  }

  function getServerForFile(filePath: string): string | undefined {
    const ext = path.extname(filePath);
    return LSP_SERVERS.find((s) => s.extensions.includes(ext))?.id;
  }

  function ensureActiveClientForFile(
    filePath: string,
    cwd: string,
  ): string | undefined {
    const absPath = normalizeFilePath(filePath, cwd);
    const serverId = getServerForFile(absPath);
    if (!serverId) return undefined;
    if (!activeClients.has(serverId)) {
      activeClients.add(serverId);
      updateLspStatus();
    }
    return absPath;
  }

  // -----------------------------------------------------------------
  // Diagnostics collection
  // -----------------------------------------------------------------

  function buildDiagnosticsOutput(
    filePath: string,
    diagnostics: Diagnostic[],
    cwd: string,
    includeFileHeader: boolean,
  ): { notification: string; errorCount: number; output: string } {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absPath);
    const errorCount = diagnostics.filter((e) => e.severity === 1).length;

    const MAX = 5;
    const lines = diagnostics.slice(0, MAX).map((e) => {
      const sev = e.severity === 1 ? "ERROR" : "WARN";
      return `${sev}[${e.range.start.line + 1}] ${diagnosticMessageText(e).split("\n")[0]}`;
    });

    let notification = `📋 ${relativePath}\n${lines.join("\n")}`;
    if (diagnostics.length > MAX)
      notification += `\n... +${diagnostics.length - MAX} more`;

    const header = includeFileHeader ? `File: ${relativePath}\n` : "";
    const output = `\n${header}This file has errors, please fix\n<file_diagnostics>\n${diagnostics.map(formatDiagnostic).join("\n")}\n</file_diagnostics>\n`;

    return { notification, errorCount, output };
  }

  async function collectDiagnostics(
    filePath: string,
    ctx: ExtensionContext,
    includeWarnings: boolean,
    includeFileHeader: boolean,
    notify = true,
  ): Promise<string | undefined> {
    const manager = getOrCreateManager(ctx.cwd, LSP_SERVERS);
    const absPath = ensureActiveClientForFile(filePath, ctx.cwd);
    if (!absPath) return undefined;

    try {
      const result = await manager.touchFileAndWait(
        absPath,
        diagnosticsWaitMsForFile(absPath),
      );
      if (!result.receivedResponse) return undefined;

      const diagnostics = includeWarnings
        ? result.diagnostics
        : result.diagnostics.filter((d) => d.severity === 1);
      if (!diagnostics.length) return undefined;

      const report = buildDiagnosticsOutput(
        filePath,
        diagnostics,
        ctx.cwd,
        includeFileHeader,
      );

      if (notify) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            report.notification,
            report.errorCount > 0 ? "error" : "warning",
          );
        }
      }

      return report.output;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------
  // Message renderer for diagnostics
  // -----------------------------------------------------------------

  pi.registerMessageRenderer("lsp-diagnostics", (message, options, theme) => {
    const raw = messageContentToText(message.content);
    const content = raw
      .replace(/\n?This file has errors, please fix\n/gi, "\n")
      .replace(/<\/?file_diagnostics>\n?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!content) return new Text("", 0, 0);

    const expanded = options.expanded === true;
    const lines = content.split("\n");
    const maxLines = expanded ? lines.length : DIAGNOSTICS_PREVIEW_LINES;
    const display = lines.slice(0, maxLines);
    const remaining = lines.length - display.length;

    const styledLines = display.map((line) =>
      line.startsWith("File: ")
        ? theme.fg("muted", line)
        : theme.fg("toolOutput", line),
    );

    if (!expanded && remaining > 0) {
      styledLines.push(theme.fg("dim", `... (${remaining} more lines)`));
    }

    return new Text(styledLines.join("\n"), 0, 0);
  });

  // -----------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Semantic code navigation through a language server (TypeScript/JavaScript, Go, Python, Rust, Terraform, Vue, Svelte, Kotlin, Swift).

Actions:
- workspace-symbols: find symbols by query across the project. file is optional and selects the project.
- definition, type-definition, implementation, references, incoming-calls (callers), outgoing-calls (callees), hover, signature: file + line/column, or file + query (identifier name).
- rename: file + position or query + newName. Writes the edits to disk.
- symbols (file, optional query), diagnostics (file), workspace-diagnostics (files), codeAction (file + position).`,
    promptSnippet:
      "Semantic code navigation: find symbol definitions across the project, references, callers, callees, implementations, types, diagnostics, and rename",
    promptGuidelines: [
      "Use lsp instead of rg for semantic questions: lsp workspace-symbols for where X is defined, lsp references for all uses of X, lsp incoming-calls for who calls X, lsp implementation for implementations of X.",
      "For lsp position actions, pass file plus query (the identifier name) instead of a guessed line/column.",
      "Use lsp rename to rename a symbol; it writes all edits to disk.",
      "Use rg for plain text, comments, strings, and non-code files.",
    ],
    parameters: LspParams,

    async execute(
      _toolCallId: string,
      params: LspParamsType,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: unknown;
    }> {
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Cancelled" }],
          details: {},
        };
      }

      const manager = getOrCreateManager(ctx.cwd, LSP_SERVERS);
      const {
        action,
        file,
        files,
        line,
        column,
        endLine,
        endColumn,
        query,
        newName,
        severity,
      } = params;
      const sevFilter: SeverityFilter = severity ?? "all";
      const needsFile =
        action !== "workspace-diagnostics" && action !== "workspace-symbols";
      const needsPos = POSITION_ACTIONS.has(action);

      if (needsFile && !file) {
        throw new Error(`Action "${action}" requires a file path.`);
      }

      let rLine = line;
      let rCol = column;
      let fromQuery = false;

      if (
        needsPos &&
        (rLine === undefined || rCol === undefined) &&
        query &&
        file
      ) {
        const resolved = await resolvePosition(manager, file, query, action === "rename");
        if (resolved) {
          rLine = resolved.line;
          rCol = resolved.column;
          fromQuery = true;
        }
      }

      if (needsPos && (rLine === undefined || rCol === undefined)) {
        throw new Error(
          `Action "${action}" requires line/column or a query matching a symbol.`,
        );
      }

      const qLine = query ? `query: ${query}\n` : "";
      const sevLine = sevFilter !== "all" ? `severity: ${sevFilter}\n` : "";
      const posLine =
        fromQuery && rLine && rCol
          ? `resolvedPosition: ${rLine}:${rCol}\n`
          : "";

      switch (action) {
        case "definition":
        case "references":
        case "implementation":
        case "type-definition": {
          const result = await runLocationAction(
            manager,
            action,
            file!,
            rLine!,
            rCol!,
            ctx.cwd,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `action: ${action}\n${qLine}${posLine}${result.text}`,
              },
            ],
            details: result.details,
          };
        }

        case "incoming-calls":
        case "outgoing-calls": {
          const result = await runCallsAction(
            manager,
            action,
            file!,
            rLine!,
            rCol!,
            ctx.cwd,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `action: ${action}\n${qLine}${posLine}${result.text}`,
              },
            ],
            details: result.details,
          };
        }

        case "workspace-symbols": {
          if (!query) {
            throw new Error('Action "workspace-symbols" requires a "query".');
          }
          const result = await runWorkspaceSymbolsAction(
            manager,
            query,
            file,
            ctx.cwd,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `action: workspace-symbols\n${qLine}${result.text}`,
              },
            ],
            details: result.details,
          };
        }

        case "hover": {
          const result = await manager.getHover(file!, rLine!, rCol!);
          const payload = result
            ? formatHover(result.contents) || "No hover information."
            : "No hover information.";
          return {
            content: [
              {
                type: "text" as const,
                text: `action: hover\n${qLine}${posLine}${payload}`,
              },
            ],
            details: result ?? null,
          };
        }

        case "symbols": {
          const symbols = await manager.getDocumentSymbols(file!);
          const lines = collectSymbols(symbols, 0, [], query);
          const payload = lines.length
            ? lines.join("\n")
            : query
              ? `No symbols matching "${query}".`
              : "No symbols found.";
          return {
            content: [
              {
                type: "text" as const,
                text: `action: symbols\n${qLine}${payload}`,
              },
            ],
            details: symbols,
          };
        }

        case "diagnostics": {
          const result = await manager.touchFileAndWait(
            file!,
            diagnosticsWaitMsForFile(file!),
          );
          const filtered = filterDiagnosticsBySeverity(
            result.diagnostics,
            sevFilter,
          );
          const payload = result.unsupported
            ? `Unsupported: ${result.error ?? "No LSP for this file."}`
            : !result.receivedResponse
              ? "Timeout: LSP server did not respond. Try again."
              : filtered.length
                ? filtered.map(formatDiagnostic).join("\n")
                : "No diagnostics.";
          return {
            content: [
              {
                type: "text" as const,
                text: `action: diagnostics\n${sevLine}${payload}`,
              },
            ],
            details: { ...result, diagnostics: filtered },
          };
        }

        case "workspace-diagnostics": {
          if (!files?.length) {
            throw new Error(
              'Action "workspace-diagnostics" requires a "files" array.',
            );
          }
          const waitMs = Math.max(...files.map(diagnosticsWaitMsForFile));
          const result = await manager.getDiagnosticsForFiles(files, waitMs);
          const out: string[] = [];
          let errors = 0;
          let warnings = 0;
          let filesWithIssues = 0;

          for (const item of result.items) {
            const display =
              ctx.cwd && path.isAbsolute(item.file)
                ? path.relative(ctx.cwd, item.file)
                : item.file;
            if (item.status !== "ok") {
              out.push(`${display}: ${item.error ?? item.status}`);
              continue;
            }
            const filtered = filterDiagnosticsBySeverity(
              item.diagnostics,
              sevFilter,
            );
            if (filtered.length) {
              filesWithIssues++;
              out.push(`${display}:`);
              for (const d of filtered) {
                if (d.severity === 1) errors++;
                else if (d.severity === 2) warnings++;
                out.push(`  ${formatDiagnostic(d)}`);
              }
            }
          }

          const summary = `Analyzed ${result.items.length} file(s): ${errors} error(s), ${warnings} warning(s) in ${filesWithIssues} file(s)`;
          return {
            content: [
              {
                type: "text" as const,
                text: `action: workspace-diagnostics\n${sevLine}${summary}\n\n${out.length ? out.join("\n") : "No diagnostics."}`,
              },
            ],
            details: result,
          };
        }

        case "signature": {
          const result = await manager.getSignatureHelp(file!, rLine!, rCol!);
          return {
            content: [
              {
                type: "text" as const,
                text: `action: signature\n${qLine}${posLine}${formatSignature(result)}`,
              },
            ],
            details: result ?? null,
          };
        }

        case "rename": {
          if (!newName)
            throw new Error('Action "rename" requires a "newName" parameter.');
          const result = await runRenameAction(
            manager,
            file!,
            rLine!,
            rCol!,
            newName,
            ctx.cwd,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `action: rename\n${qLine}${posLine}${result.text}`,
              },
            ],
            details: result.details,
          };
        }

        case "codeAction": {
          const result = await manager.getCodeActions(
            file!,
            rLine!,
            rCol!,
            endLine,
            endColumn,
          );
          const actions = formatCodeActions(result);
          return {
            content: [
              {
                type: "text" as const,
                text: `action: codeAction\n${qLine}${posLine}${actions.length ? actions.join("\n") : "No code actions available."}`,
              },
            ],
            details: result,
          };
        }

        default: {
          throw new Error(`Unknown action: ${action}`);
        }
      }
    },

    renderCall(args: LspParamsType, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("lsp ")) +
        theme.fg("accent", args.action ?? "...") +
        (args.file ? " " + theme.fg("muted", args.file) : "") +
        (args.files?.length
          ? " " + theme.fg("muted", `${args.files.length} file(s)`)
          : "") +
        (args.query
          ? " " + theme.fg("dim", `query="${args.query}"`)
          : args.line !== undefined && args.column !== undefined
            ? theme.fg("warning", `:${args.line}:${args.column}`)
            : "") +
        (args.newName ? " " + theme.fg("accent", `→ ${args.newName}`) : "") +
        (args.severity && args.severity !== "all"
          ? " " + theme.fg("dim", `[${args.severity}]`)
          : "");
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text("", 0, 0);

      const textContent =
        (
          result.content?.find((c: { type: string }) => c.type === "text") as {
            text?: string;
          }
        )?.text ?? "";
      const lines = textContent.split("\n");

      let headerEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        if (
          /^(action|query|severity|resolvedPosition|project|target|newName):/.test(
            lines[i],
          )
        ) {
          headerEnd = i + 1;
        } else {
          break;
        }
      }

      const header = lines.slice(0, headerEnd);
      const content = lines.slice(headerEnd);
      const maxLines = options.expanded
        ? content.length
        : DIAGNOSTICS_PREVIEW_LINES;
      const display = content.slice(0, maxLines);
      const remaining = content.length - maxLines;

      let out = header.map((l: string) => theme.fg("muted", l)).join("\n");
      if (display.length) {
        if (out) out += "\n";
        out += display.map((l: string) => theme.fg("toolOutput", l)).join("\n");
      }
      if (remaining > 0) {
        out += theme.fg("dim", `\n... (${remaining} more lines)`);
      }

      return new Text(out, 0, 0);
    },
  });

  // -----------------------------------------------------------------
  // /lsp command
  // -----------------------------------------------------------------

  pi.registerCommand("lsp", {
    description: "LSP settings (auto diagnostics hook)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("LSP settings require UI", "warning");
        return;
      }

      const currentMark = " ✓";
      const modeOptions = (
        ["edit_write", "agent_end", "disabled"] as HookMode[]
      ).map((mode) => ({
        mode,
        label:
          mode === hookMode
            ? `${MODE_LABELS[mode]}${currentMark}`
            : MODE_LABELS[mode],
      }));

      const modeChoice = await ctx.ui.select(
        "LSP auto diagnostics hook mode:",
        modeOptions.map((o) => o.label),
      );
      if (!modeChoice) return;

      const nextMode = modeOptions.find((o) => o.label === modeChoice)?.mode;
      if (!nextMode) return;

      const scopeOptions = [
        { scope: "session" as HookScope, label: "Session only" },
        { scope: "global" as HookScope, label: "Global (all sessions)" },
      ];

      const scopeChoice = await ctx.ui.select(
        "Apply LSP auto diagnostics hook setting to:",
        scopeOptions.map((o) => o.label),
      );
      if (!scopeChoice) return;

      const scope = scopeOptions.find((o) => o.label === scopeChoice)?.scope;
      if (!scope) return;

      if (scope === "global") {
        const ok = setGlobalHookMode(nextMode);
        if (!ok) {
          ctx.ui.notify("Failed to update global settings", "error");
          return;
        }
      }

      hookMode = nextMode;
      hookScope = scope;
      touchedFiles.clear();
      pi.appendEntry<HookConfigEntry>(LSP_CONFIG_ENTRY, {
        scope,
        hookMode: nextMode,
      });
      updateLspStatus();
      ctx.ui.notify(
        `LSP hook: ${MODE_LABELS[hookMode]} (${hookScope})`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------
  // Event hooks
  // -----------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    restoreHookState(ctx);
    statusUi = ctx.hasUI ? ctx.ui : null;
    updateLspStatus();

    if (hookMode === "disabled") return;

    // Warmup: detect project markers and pre-spawn appropriate LSP
    const manager = getOrCreateManager(ctx.cwd, LSP_SERVERS);
    for (const [marker, ext] of Object.entries(WARMUP_MAP)) {
      if (fs.existsSync(path.join(ctx.cwd, marker))) {
        manager
          .getClientsForFile(path.join(ctx.cwd, `dummy${ext}`))
          .then((clients) => {
            if (clients.length > 0) {
              const cfg = LSP_SERVERS.find((s) => s.extensions.includes(ext));
              if (cfg) activeClients.add(cfg.id);
              updateLspStatus();
            }
          })
          .catch(() => {});
        break;
      }
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreHookState(ctx);
    updateLspStatus();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    clearIdleShutdownTimer();
    diagnosticsAbort?.abort();
    diagnosticsAbort = null;
    await shutdownManager();
    activeClients.clear();
    statusUi?.setStatus("lsp", undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    const input =
      event.input && typeof event.input === "object"
        ? (event.input as Record<string, unknown>)
        : {};

    if (event.toolName === "lsp") {
      clearIdleShutdownTimer();
      // Pre-warm clients for referenced files
      const files: string[] = [];
      if (typeof input.file === "string") files.push(input.file);
      if (Array.isArray(input.files)) {
        for (const f of input.files) {
          if (typeof f === "string") files.push(f);
        }
      }
      for (const file of files) {
        ensureActiveClientForFile(file, ctx.cwd);
      }
      return;
    }

    if (
      event.toolName !== "read" &&
      event.toolName !== "write" &&
      event.toolName !== "edit"
    ) {
      return;
    }

    clearIdleShutdownTimer();
    // read and write have input.path. The unified edit tool has input.text
    // with `[path]` file headers.
    const filePaths =
      event.toolName === "edit" && typeof input.text === "string"
        ? editHeaderPaths(input.text)
        : typeof input.path === "string"
          ? [input.path]
          : [];

    const manager = getOrCreateManager(ctx.cwd, LSP_SERVERS);
    for (const filePath of filePaths) {
      const absPath = ensureActiveClientForFile(filePath, ctx.cwd);
      if (!absPath) continue;
      // Pre-warm the client
      manager.getClientsForFile(absPath).catch(() => {});
    }
  });

  pi.on("agent_start", async () => {
    clearIdleShutdownTimer();
    diagnosticsAbort?.abort();
    diagnosticsAbort = null;
    touchedFiles.clear();
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      if (hookMode !== "agent_end") return;

      // Don't run diagnostics on aborted/error runs
      const wasAborted = event.messages.some((m) => {
        if (m.role !== "assistant") return false;
        const assistant = m as { stopReason?: string };
        return (
          assistant.stopReason === "aborted" || assistant.stopReason === "error"
        );
      });
      if (wasAborted) {
        touchedFiles.clear();
        return;
      }

      if (touchedFiles.size === 0) return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

      const abort = new AbortController();
      diagnosticsAbort?.abort();
      diagnosticsAbort = abort;

      const files = Array.from(touchedFiles.entries());
      touchedFiles.clear();

      try {
        const outputs: string[] = [];
        for (const [filePath, includeWarnings] of files) {
          if (shuttingDown || abort.signal.aborted) return;
          if (!ctx.isIdle() || ctx.hasPendingMessages()) {
            abort.abort();
            return;
          }

          const output = await collectDiagnostics(
            filePath,
            ctx,
            includeWarnings,
            true,
            false,
          );
          if (abort.signal.aborted) return;
          if (output) outputs.push(output);
        }

        if (shuttingDown || abort.signal.aborted) return;

        if (outputs.length) {
          pi.sendMessage(
            {
              customType: "lsp-diagnostics",
              content: outputs.join("\n"),
              display: true,
            },
            {
              triggerTurn: true,
              deliverAs: "followUp",
            },
          );
        }
      } finally {
        if (diagnosticsAbort === abort) diagnosticsAbort = null;
      }
    } finally {
      if (!shuttingDown) scheduleIdleShutdown();
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;

    // write has input.path. The unified edit tool lists changed files in details.
    const filePaths =
      event.toolName === "edit"
        ? editedPathsFromDetails(event.details)
        : typeof event.input.path === "string"
          ? [event.input.path]
          : [];
    const absPaths = filePaths
      .map((filePath) => ensureActiveClientForFile(filePath, ctx.cwd))
      .filter((absPath): absPath is string => absPath !== undefined);
    if (!absPaths.length) return;

    if (hookMode === "disabled") return;

    const includeWarnings = event.toolName === "write";
    if (hookMode === "agent_end") {
      for (const absPath of absPaths) {
        const existing = touchedFiles.get(absPath) ?? false;
        touchedFiles.set(absPath, existing || includeWarnings);
      }
      return;
    }

    // edit_write mode: inline diagnostics
    const outputs: string[] = [];
    for (const absPath of absPaths) {
      const output = await collectDiagnostics(
        absPath,
        ctx,
        includeWarnings,
        absPaths.length > 1,
      );
      if (output) outputs.push(output);
    }
    if (!outputs.length) return;

    return {
      content: [
        ...(event.content as Array<{ type: "text"; text: string }>),
        { type: "text" as const, text: outputs.join("\n") },
      ],
    };
  });
}
