import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
  HindsightClient,
  HindsightError,
  type MentalModelResponse,
  type RecallResponse,
} from "@vectorize-io/hindsight-client";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { isSubagent } from "../_lib/env.js";
import { getNamespacedConfig } from "../_lib/settings.js";

const BUDGETS = ["low", "mid", "high"] as const;
const MEMORY_TYPES = ["world", "experience", "observation"] as const;
const TAGS_MATCH = ["any", "all", "any_strict", "all_strict"] as const;
const DYNAMIC_BANK_FIELDS = ["agent", "project", "gitProject", "user"] as const;
const HINDSIGHT_STATUS_ICON = "🧠";

type Budget = (typeof BUDGETS)[number];
type MemoryType = (typeof MEMORY_TYPES)[number];
type TagsMatch = (typeof TAGS_MATCH)[number];
type DynamicBankField = (typeof DYNAMIC_BANK_FIELDS)[number];
type TextContent = string | Array<{ type: string; text?: string }>;

interface HindsightConfig {
  baseUrl: string;
  apiKey: string;
  bankId: string;
  bankIdPrefix: string;
  dynamicBankId: boolean;
  dynamicBankGranularity: string[];
  userName: string;
  aiName: string;
  enabled: boolean;
  injectContext: boolean;
  storeMessages: boolean;
  writeAsync: boolean;
  contextBudget: string;
  recallBudget: string;
  contextTokens: number;
  recallMaxTokens: number;
  recallMaxQueryChars: number;
  recallIncludeEntities: boolean;
  autoRecallRecentMessages: number;
  autoRecallMaxMessageChars: number;
  autoRecallDeadlineMs: number;
  autoRecallInSubagents: boolean;
  recallTypes: string[];
  recallTags: string[];
  recallTagsMatch: TagsMatch;
  recallPromptPreamble: string;
  refreshInterval: number;
  retainEveryNTurns: number;
  retainContext: string;
  retainTags: string[];
  maxRetainedChars: number;
  bankMission: string;
  retainMission: string;
  observationsMission: string;
  injectMentalModels: boolean;
  mentalModelRefreshAfterConsolidation: boolean;
  showAutoRecallMessages: boolean;
  showAutoRecallEmptyMessages: boolean;
}

interface HindsightStatus {
  connected: boolean;
  bankId: string;
  baseUrl: string;
  sessionTag: string;
  turnCounter: number;
  cachedContextChars: number;
  pendingWrites: number;
}

interface RecallDetails {
  status: "ok" | "unavailable";
  query: string;
  resultCount: number;
  outputChars?: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

interface ReflectDetails {
  status: "ok" | "unavailable";
  query: string;
  outputChars?: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

interface AutoRecallResult {
  status: "ok" | "empty" | "failed";
  query: string;
  resultCount: number;
  context: string | null;
  memoryText?: string;
  latencyMs?: number;
  error?: string;
}

interface AutoRecallMessageDetails {
  status: AutoRecallResult["status"];
  query: string;
  resultCount: number;
  contextChars?: number;
  memoryText?: string;
  latencyMs?: number;
  usedCachedContext: boolean;
  appliedToCurrentTurn: boolean;
  error?: string;
}

interface RecentConversationMessage {
  role: "user" | "assistant";
  text: string;
}

interface SessionMessageEntryLike {
  type: string;
  message?: {
    role?: string;
    content?: TextContent;
  };
}

interface RetainDetails {
  status: "ok" | "unavailable";
  bankId: string;
  tags: string[];
  contentChars?: number;
  category?: string;
}

const config = getNamespacedConfig("hindsight", {
  baseUrl: "http://localhost:8888",
  apiKey: "",
  bankId: "pi",
  bankIdPrefix: "",
  dynamicBankId: false,
  dynamicBankGranularity: ["agent", "gitProject"],
  userName: process.env.USER ?? "user",
  aiName: "pi",
  enabled: true,
  injectContext: true,
  storeMessages: true,
  writeAsync: true,
  contextBudget: "low",
  recallBudget: "low",
  contextTokens: 4000,
  recallMaxTokens: 1024,
  recallMaxQueryChars: 1800,
  recallIncludeEntities: false,
  autoRecallRecentMessages: 5,
  autoRecallMaxMessageChars: 300,
  autoRecallDeadlineMs: 1000,
  autoRecallInSubagents: false,
  recallTypes: ["observation"],
  recallTags: [],
  recallTagsMatch: "any",
  recallPromptPreamble:
    "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:",
  refreshInterval: 1,
  retainEveryNTurns: 1,
  retainContext: "pi-coding-agent",
  retainTags: ["session:{session_id}", "bank:{bank_id}", "user:{user_id}"],
  maxRetainedChars: 12000,
  bankMission:
    "You are pi, a coding agent. Use memories to answer questions about the user's durable preferences, workflow, projects, and previous technical decisions.",
  retainMission:
    "Extract durable software engineering preferences, workflow habits, project facts, technical decisions, corrections, and task outcomes. Ignore transient command output and low-level tool noise unless it changes future behavior.",
  observationsMission:
    "Synthesize stable observations about the user, projects, preferences, workflows, and technical decisions that will help future coding-agent sessions.",
  injectMentalModels: true,
  mentalModelRefreshAfterConsolidation: false,
  showAutoRecallMessages: true,
  showAutoRecallEmptyMessages: false,
}) as HindsightConfig;

const DEFAULT_MENTAL_MODELS = [
  {
    id: "developer-preferences",
    name: "Developer Preferences",
    sourceQuery:
      "Create a concise coding-agent briefing containing only durable, user-wide software-engineering preferences that match these allowed topics: delegate to subagents when appropriate; parallelize non-conflicting work; read and re-read files before editing; make minimal focused changes; keep code simple and avoid unnecessary abstractions; prefer strong typing and avoid any/unknown; prefer TypeScript and Go when choosing languages; use ripgrep for search; use Graphite for git workflow; require explicit approval for destructive operations; verify with concrete evidence before claiming completion; look up external library/API/tool documentation; push back when the user's approach seems wrong; do not commit automatically unless asked. Omit every other topic, even if present in memory. Do not include project-specific stacks, package managers, runtimes, exact test/typecheck commands, TODO workflows, commit-skill workflows, review UI names, model/provider choices, file-length limits, citations, memory IDs, or evidence labels. Use only short actionable bullets under: Always do, Code style, Verification and review, Avoid.",
  },
] as const;

const INJECTED_MENTAL_MODEL_IDS = new Set<string>(["developer-preferences"]);

let enabled = false;
let client: HindsightClient | null = null;
let currentBankId = config.bankId;
let sessionTag = "unknown";
let cachedContext: string | null = null;
let cachedMentalModelContext: string | null = null;
let turnCounter = 0;
let pendingWrites: Promise<void>[] = [];
let pendingAutoRecall: Promise<void> | null = null;
let eagerMentalModelContextPromise: Promise<string | null> | null = null;

function sanitizePath(cwd: string): string {
  const home = os.homedir();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return relative.replace(/\//g, "--");
}

function normalizeBudget(value: string, fallback: Budget): Budget {
  return BUDGETS.includes(value as Budget) ? (value as Budget) : fallback;
}

function normalizeTagsMatch(value: string): TagsMatch {
  return TAGS_MATCH.includes(value as TagsMatch) ? (value as TagsMatch) : "any";
}

function normalizeMemoryTypes(
  types: string[] | undefined,
): MemoryType[] | undefined {
  if (!types) return undefined;
  const filtered = types.filter((type): type is MemoryType =>
    MEMORY_TYPES.includes(type as MemoryType),
  );
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeDynamicBankFields(fields: string[]): DynamicBankField[] {
  const filtered = fields.filter((field): field is DynamicBankField =>
    DYNAMIC_BANK_FIELDS.includes(field as DynamicBankField),
  );
  return filtered.length > 0 ? filtered : ["agent", "gitProject"];
}

function extractTextContent(content: TextContent): string | null {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n");

  const cleaned = stripMemoryTags(text).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function stripMemoryTags(content: string): string {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<hindsight_mental_models>[\s\S]*?<\/hindsight_mental_models>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "");
}

function describeError(error: Error): string {
  if (error instanceof HindsightError && error.statusCode) {
    return `${error.message} (HTTP ${error.statusCode})`;
  }
  return error.message;
}

function formatCurrentTime(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function getMainGitProjectName(cwd: string): string | null {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      },
    ).trim();
    if (!commonDir) return null;
    return basename(commonDir) === ".git"
      ? basename(dirname(commonDir))
      : basename(commonDir);
  } catch {
    return null;
  }
}

function deriveBankId(cwd: string): string {
  const prefix = config.bankIdPrefix;
  if (!config.dynamicBankId) {
    return prefix ? `${prefix}-${config.bankId}` : config.bankId;
  }

  const fields = normalizeDynamicBankFields(config.dynamicBankGranularity);
  const values: Record<DynamicBankField, string> = {
    agent: config.aiName || "pi",
    project: basename(cwd) || "unknown",
    gitProject: getMainGitProjectName(cwd) ?? basename(cwd) ?? "unknown",
    user: process.env.HINDSIGHT_USER_ID || config.userName || "anonymous",
  };
  const baseBankId = fields.map((field) => values[field]).join("::");
  return prefix ? `${prefix}-${baseBankId}` : baseBankId;
}

function formatRecallResponse(response: RecallResponse): string {
  if (response.results.length === 0) return "";

  return response.results
    .map((result) => {
      const type = result.type ? ` [${result.type}]` : "";
      return `- ${result.text}${type}`;
    })
    .join("\n\n");
}

function formatRecallContext(response: RecallResponse): string | null {
  const memories = formatRecallResponse(response);
  if (!memories) return null;

  return [
    "<hindsight_memories>",
    config.recallPromptPreamble,
    `Current time - ${formatCurrentTime()}`,
    "",
    memories,
    "</hindsight_memories>",
  ].join("\n");
}

interface MentalModelJsonResponse {
  answer?: string;
}

function stripMentalModelEvidenceLabels(content: string): string {
  const uuidSeparator = "[-\\u2010-\\u2015]";
  const uuidPattern = `[0-9a-f]{8}${uuidSeparator}[0-9a-f]{4}${uuidSeparator}[0-9a-f]{4}${uuidSeparator}[0-9a-f]{4}${uuidSeparator}[0-9a-f]{12}`;
  const citationPattern = new RegExp(
    String.raw`[\s\u202f]*[*_]*\([^\n)]*${uuidPattern}[^\n)]*\)[*_]*`,
    "gi",
  );
  const uuidOnlyPattern = new RegExp(uuidPattern, "gi");

  return content
    .replace(citationPattern, "")
    .replace(uuidOnlyPattern, "")
    .replace(/[()]{2,}/g, "")
    .replace(/[ \t\u202f]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMentalModelContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return stripMentalModelEvidenceLabels(trimmed);
  }

  try {
    const parsed = JSON.parse(trimmed) as MentalModelJsonResponse;
    if (typeof parsed.answer === "string") {
      return stripMentalModelEvidenceLabels(parsed.answer);
    }
  } catch {
    // Fall through to evidence-label stripping for non-JSON content.
  }

  return stripMentalModelEvidenceLabels(trimmed);
}

function formatMentalModelContext(
  mentalModels: MentalModelResponse[],
): string | null {
  const sections = mentalModels
    .map((mentalModel) => {
      const content = mentalModel.content
        ? normalizeMentalModelContent(mentalModel.content)
        : null;
      if (!content) return null;
      return `### ${mentalModel.name}\n${content}`;
    })
    .filter((section): section is string => section !== null);

  if (sections.length === 0) return null;

  const body = sections.join("\n\n");
  const charBudget = Math.max(1000, Math.floor(config.contextTokens * 4));
  const content =
    body.length <= charBudget
      ? body
      : `${body.slice(0, charBudget)}\n\n[Hindsight mental model context truncated: original length ${body.length} characters]`;

  return [
    "<hindsight_mental_models>",
    "Stable Hindsight mental models loaded at session start. Treat these as high-signal user context; prefer newer task-specific memories if they conflict.",
    `Current time - ${formatCurrentTime()}`,
    "",
    content,
    "</hindsight_mental_models>",
  ].join("\n");
}

function getInjectedContext(): string | null {
  const parts = [cachedMentalModelContext, cachedContext].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : null;
}

async function fetchMentalModelContext(
  signal?: AbortSignal,
): Promise<string | null> {
  if (!client) return null;

  const mentalModels: MentalModelResponse[] = [];
  for (const model of DEFAULT_MENTAL_MODELS) {
    if (!INJECTED_MENTAL_MODEL_IDS.has(model.id)) continue;

    try {
      mentalModels.push(
        await client.getMentalModel(currentBankId, model.id, { signal }),
      );
    } catch (error) {
      if (error instanceof HindsightError && error.statusCode === 404) {
        continue;
      }
      throw error;
    }
  }

  return formatMentalModelContext(mentalModels);
}

function startEagerMentalModelContextFetch(): void {
  eagerMentalModelContextPromise = fetchMentalModelContext()
    .then((context) => {
      cachedMentalModelContext = context;
      return context;
    })
    .catch(() => null)
    .finally(() => {
      eagerMentalModelContextPromise = null;
    });
}

function buildRecallQuery(prompt: string): string {
  const query = stripMemoryTags(prompt).trim();
  if (query.length <= config.recallMaxQueryChars) return query;
  return query.slice(0, config.recallMaxQueryChars);
}

function truncateForRecallQuery(text: string): string {
  const maxChars = Math.max(100, config.autoRecallMaxMessageChars);
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

function collectRecentConversation(
  entries: SessionMessageEntryLike[],
  currentPrompt: string,
): RecentConversationMessage[] {
  const recent: RecentConversationMessage[] = [];
  const maxMessages = Math.max(0, config.autoRecallRecentMessages);
  const currentPromptText = stripMemoryTags(currentPrompt).trim();
  let skippedCurrentPrompt = false;

  for (const entry of entries.slice().reverse()) {
    if (recent.length >= maxMessages) break;
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!message) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    if (!message.content) continue;

    const text = extractTextContent(message.content);
    if (!text) continue;

    if (
      !skippedCurrentPrompt &&
      role === "user" &&
      text.trim() === currentPromptText
    ) {
      skippedCurrentPrompt = true;
      continue;
    }

    recent.push({ role, text: truncateForRecallQuery(text) });
  }

  return recent;
}

function buildAutoRecallQuery(
  prompt: string,
  cwd: string,
  recentConversation: RecentConversationMessage[],
): string {
  const currentPrompt = stripMemoryTags(prompt).trim();
  const sections = [
    `Current user request:\n${currentPrompt}`,
    "Recall memories relevant to this current coding task, including user preferences, project conventions, previous decisions, and prior task context.",
    [
      "Project/session:",
      `- cwd: ${cwd}`,
      `- bank: ${currentBankId}`,
      `- session: ${sessionTag}`,
    ].join("\n"),
  ];

  if (recentConversation.length > 0) {
    const recent = recentConversation
      .map((message) => `[${message.role}] ${message.text}`)
      .join("\n\n");
    sections.push(`Recent conversation (newest first):\n${recent}`);
  }

  return sections.join("\n\n");
}

async function truncateForTool(
  text: string,
  prefix: string,
): Promise<{
  text: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content };
  }

  const tempDir = await mkdtemp(join(tmpdir(), `pi-${prefix}-`));
  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, text, "utf8");
  });

  const truncatedLines = truncation.totalLines - truncation.outputLines;
  const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
  const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted. Full output saved to: ${tempFile}]`;

  return {
    text: truncation.content + notice,
    truncation,
    fullOutputPath: tempFile,
  };
}

function previewText(text: string, maxChars = 88): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderHindsightCall(
  label: string,
  preview: string,
  theme: Theme,
): Text {
  let text = theme.fg("toolTitle", theme.bold(`${label} `));
  text += theme.fg("accent", `"${previewText(preview)}"`);
  return new Text(text, 0, 0);
}

function renderRecallResult(
  result: AgentToolResult<RecallDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  if (options.isPartial) {
    return new Text(
      theme.fg("warning", "Recalling Hindsight memories..."),
      0,
      0,
    );
  }

  const details = result.details;
  if (details.status === "unavailable") {
    return new Text(theme.fg("warning", "Hindsight is not connected"), 0, 0);
  }

  const noun = details.resultCount === 1 ? "memory" : "memories";
  let text = theme.fg("success", `✓ Recalled ${details.resultCount} ${noun}`);
  if (details.outputChars !== undefined) {
    text += theme.fg(
      "dim",
      ` (${details.outputChars.toLocaleString()} chars returned to model)`,
    );
  }
  if (details.truncation) {
    text += theme.fg("warning", " (truncated for model)");
  }

  if (options.expanded) {
    text += `\n${theme.fg("dim", `Query: ${details.query}`)}`;
    if (details.fullOutputPath) {
      text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
    }
  }

  return new Text(text, 0, 0);
}

function renderReflectResult(
  result: AgentToolResult<ReflectDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Reflecting with Hindsight..."), 0, 0);
  }

  const details = result.details;
  if (details.status === "unavailable") {
    return new Text(theme.fg("warning", "Hindsight is not connected"), 0, 0);
  }

  let text = theme.fg("success", "✓ Hindsight reflection complete");
  if (details.outputChars !== undefined) {
    text += theme.fg(
      "dim",
      ` (${details.outputChars.toLocaleString()} chars returned to model)`,
    );
  }
  if (details.truncation) {
    text += theme.fg("warning", " (truncated for model)");
  }

  if (options.expanded) {
    text += `\n${theme.fg("dim", `Query: ${details.query}`)}`;
    if (details.fullOutputPath) {
      text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
    }
  }

  return new Text(text, 0, 0);
}

function renderRetainResult(
  result: AgentToolResult<RetainDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Saving Hindsight memory..."), 0, 0);
  }

  const details = result.details;
  if (details.status === "unavailable") {
    return new Text(theme.fg("warning", "Hindsight is not connected"), 0, 0);
  }

  let text = theme.fg("success", "✓ Saved to Hindsight");
  if (details.contentChars !== undefined) {
    text += theme.fg(
      "dim",
      ` (${details.contentChars.toLocaleString()} chars)`,
    );
  }

  if (options.expanded) {
    text += `\n${theme.fg("dim", `Bank: ${details.bankId}`)}`;
    text += `\n${theme.fg("dim", `Tags: ${details.tags.join(", ")}`)}`;
  }

  return new Text(text, 0, 0);
}

function renderAutoRecallMessage(
  details: Partial<AutoRecallMessageDetails> | undefined,
  content: string,
  expanded: boolean,
  theme: Theme,
): Text {
  const status = details?.status ?? "ok";
  const color =
    status === "failed" ? "warning" : status === "empty" ? "dim" : "success";
  const icon =
    status === "failed"
      ? `${HINDSIGHT_STATUS_ICON}⚠`
      : status === "empty"
        ? `${HINDSIGHT_STATUS_ICON}0`
        : `${HINDSIGHT_STATUS_ICON}✓`;
  let text = `${theme.fg(color, icon)} ${theme.fg("dim", content)}`;

  if (expanded) {
    if (details?.query) {
      text += `\n${theme.fg("dim", `  Query: ${details.query}`)}`;
    }
    if (typeof details?.resultCount === "number") {
      text += `\n${theme.fg("dim", `  Results: ${details.resultCount}`)}`;
    }
    if (typeof details?.latencyMs === "number") {
      text += `\n${theme.fg("dim", `  Latency: ${formatLatency(details.latencyMs)}`)}`;
    }
    if (typeof details?.appliedToCurrentTurn === "boolean") {
      const scope = details.appliedToCurrentTurn
        ? "current turn"
        : "future turns";
      text += `\n${theme.fg("dim", `  Applies to: ${scope}`)}`;
    }
    if (typeof details?.contextChars === "number") {
      const chars = details.contextChars.toLocaleString();
      text += `\n${theme.fg("dim", `  Context: ${chars} chars`)}`;
    }
    if (details?.usedCachedContext) {
      text += `\n${theme.fg(
        "warning",
        "  Used cached context from previous recall",
      )}`;
    }
    if (details?.error) {
      text += `\n${theme.fg("warning", `  Error: ${details.error}`)}`;
    }
    if (details?.memoryText) {
      text += `\n${theme.fg("dim", "  Memories:")}`;
      text += `\n${details.memoryText}`;
    }
  }

  return new Text(text, 0, 0);
}

type HindsightStatusState =
  | "connected"
  | "recalling"
  | "recalled"
  | "unavailable";

type HindsightStatusContext = {
  ui: {
    theme: Theme;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(id: string, value: string | undefined): void;
  };
};

function setHindsightStatus(
  ctx: HindsightStatusContext,
  state: HindsightStatusState,
): void {
  const theme = ctx.ui.theme;
  if (state === "recalling") {
    ctx.ui.setStatus(
      "hindsight",
      theme.fg("accent", `${HINDSIGHT_STATUS_ICON}↻`),
    );
    return;
  }
  if (state === "recalled") {
    ctx.ui.setStatus(
      "hindsight",
      theme.fg("success", `${HINDSIGHT_STATUS_ICON}✓`),
    );
    return;
  }
  if (state === "unavailable") {
    ctx.ui.setStatus("hindsight", `${HINDSIGHT_STATUS_ICON}🔴`);
    return;
  }
  ctx.ui.setStatus("hindsight", `${HINDSIGHT_STATUS_ICON}🟢`);
}

function formatAutoRecallContent(
  result: AutoRecallResult,
  appliedToCurrentTurn: boolean,
): string {
  const noun = result.resultCount === 1 ? "memory" : "memories";
  const latencySuffix =
    typeof result.latencyMs === "number"
      ? ` in ${formatLatency(result.latencyMs)}`
      : "";
  const turnScope = appliedToCurrentTurn ? "this turn" : "future turns";
  if (result.status === "failed") return `Hindsight recall failed${latencySuffix}`;
  if (result.status === "empty") {
    return `No Hindsight memories matched ${turnScope}${latencySuffix}`;
  }
  return `Recalled ${result.resultCount} Hindsight ${noun} for ${turnScope}${latencySuffix}`;
}

function sendAutoRecallMessage(
  pi: ExtensionAPI,
  result: AutoRecallResult,
  usedCachedContext: boolean,
  appliedToCurrentTurn: boolean,
): void {
  if (!config.showAutoRecallMessages) return;
  if (result.status === "empty" && !config.showAutoRecallEmptyMessages) return;

  const content = formatAutoRecallContent(result, appliedToCurrentTurn);

  pi.sendMessage({
    customType: "hindsight-auto-recall",
    content,
    display: true,
    details: {
      status: result.status,
      query: result.query,
      resultCount: result.resultCount,
      contextChars: result.context?.length,
      memoryText: result.memoryText,
      latencyMs: result.latencyMs,
      usedCachedContext,
      appliedToCurrentTurn,
      error: result.error,
    } satisfies AutoRecallMessageDetails,
  });
}

function notifyAutoRecallResult(
  ctx: HindsightStatusContext,
  result: AutoRecallResult,
): void {
  if (!config.showAutoRecallMessages) return;
  if (result.status === "empty" && !config.showAutoRecallEmptyMessages) return;

  const content = formatAutoRecallContent(result, false);
  ctx.ui.notify(content, result.status === "failed" ? "warning" : "info");
}

async function ensureBank(
  hindsight: HindsightClient,
  bankId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await hindsight.createBank(bankId, {
      name: config.aiName,
      reflectMission: config.bankMission,
      retainMission: config.retainMission,
      enableObservations: true,
      observationsMission: config.observationsMission,
      signal,
    });
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }

  await ensureDefaultMentalModels(hindsight, bankId, signal);
}

async function ensureDefaultMentalModels(
  hindsight: HindsightClient,
  bankId: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const model of DEFAULT_MENTAL_MODELS) {
    try {
      await hindsight.getMentalModel(bankId, model.id, { signal });
      await hindsight.updateMentalModel(bankId, model.id, {
        name: model.name,
        sourceQuery: model.sourceQuery,
        trigger: {
          refreshAfterConsolidation:
            config.mentalModelRefreshAfterConsolidation,
        },
        signal,
      });
    } catch (error) {
      if (error instanceof HindsightError && error.statusCode === 404) {
        await hindsight.createMentalModel(
          bankId,
          model.name,
          model.sourceQuery,
          {
            id: model.id,
            trigger: {
              refreshAfterConsolidation:
                config.mentalModelRefreshAfterConsolidation,
            },
            signal,
          },
        );
      }
    }
  }
}

type DeadlineResult<T> =
  | { status: "completed"; value: T }
  | { status: "timed-out" };

async function resolveWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<DeadlineResult<T>> {
  if (deadlineMs <= 0) {
    return { status: "completed", value: await promise };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<DeadlineResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed-out" }), deadlineMs);
  });

  try {
    return await Promise.race([
      promise.then((value) => ({ status: "completed", value }) as const),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchHindsightContext(
  prompt: string,
  signal?: AbortSignal,
): Promise<AutoRecallResult> {
  const query = buildRecallQuery(prompt);
  if (!client) {
    return {
      status: "failed",
      query,
      resultCount: 0,
      context: null,
      error: "Hindsight client is not initialized",
    };
  }

  if (!query) {
    return { status: "empty", query, resultCount: 0, context: null };
  }

  const recallStartedAt = Date.now();

  try {
    const response = await client.recall(currentBankId, query, {
      budget: normalizeBudget(config.recallBudget, "mid"),
      maxTokens: config.recallMaxTokens,
      types: normalizeMemoryTypes(config.recallTypes),
      includeEntities: config.recallIncludeEntities,
      tags: config.recallTags.length > 0 ? config.recallTags : undefined,
      tagsMatch:
        config.recallTags.length > 0
          ? normalizeTagsMatch(config.recallTagsMatch)
          : undefined,
      signal,
    });
    const latencyMs = Date.now() - recallStartedAt;
    const memoryText = formatRecallResponse(response) || undefined;
    const context = formatRecallContext(response);
    if (!context) {
      return {
        status: "empty",
        query,
        resultCount: response.results.length,
        context: null,
        memoryText,
        latencyMs,
      };
    }
    const charBudget = Math.max(1000, Math.floor(config.contextTokens * 4));
    return {
      status: "ok",
      query,
      resultCount: response.results.length,
      context: context.slice(0, charBudget),
      memoryText,
      latencyMs,
    };
  } catch (error) {
    return {
      status: "failed",
      query,
      resultCount: 0,
      context: null,
      latencyMs: Date.now() - recallStartedAt,
      error: error instanceof Error ? describeError(error) : String(error),
    };
  }
}

function buildMessageMemory(
  messages: Array<{ role: string; content?: TextContent }>,
): string | null {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!message.content) continue;

    const text = extractTextContent(message.content);
    if (!text) continue;

    parts.push(`[role: ${message.role}]\n${text}\n[${message.role}:end]`);
  }

  if (parts.length === 0) return null;

  const transcript = parts.join("\n\n");
  if (transcript.length <= config.maxRetainedChars) return transcript;

  return `${transcript.slice(0, config.maxRetainedChars)}\n\n[Transcript truncated before retention: original length ${transcript.length} characters]`;
}

function resolveTemplate(value: string, timestamp: string): string {
  return value
    .replaceAll("{session_id}", sessionTag)
    .replaceAll("{bank_id}", currentBankId)
    .replaceAll("{timestamp}", timestamp)
    .replaceAll("{user_id}", process.env.HINDSIGHT_USER_ID ?? "");
}

function resolveConfiguredRetainTags(timestamp: string): string[] {
  const tags: string[] = [];
  for (const tag of config.retainTags) {
    const resolved = resolveTemplate(tag, timestamp);
    if (resolved.includes(":") && resolved.split(":", 2)[1] === "") continue;
    if (resolved.trim().length > 0) tags.push(resolved);
  }
  return tags;
}

function memoryTags(extra: string[] = []): string[] {
  const timestamp = new Date().toISOString();
  return [
    "source:pi",
    `user:${config.userName}`,
    `agent:${config.aiName}`,
    `project:${sessionTag}`,
    ...resolveConfiguredRetainTags(timestamp),
    ...extra,
  ];
}

function getStatus(): HindsightStatus {
  return {
    connected: enabled,
    bankId: currentBankId,
    baseUrl: config.baseUrl,
    sessionTag,
    turnCounter,
    cachedContextChars: getInjectedContext()?.length ?? 0,
    pendingWrites: pendingWrites.length,
  };
}

const RecallParams = Type.Object({
  query: Type.String({
    description: "Natural language query to search Hindsight memory.",
  }),
  types: Type.Optional(
    Type.Array(StringEnum(MEMORY_TYPES), {
      description: "Memory types to recall: world, experience, observation.",
    }),
  ),
  budget: Type.Optional(
    StringEnum(BUDGETS, { description: "Recall budget: low, mid, or high." }),
  ),
  maxTokens: Type.Optional(
    Type.Number({ description: "Maximum memory context tokens to return." }),
  ),
  tags: Type.Optional(Type.Array(Type.String({ description: "Tag filter." }))),
});

type RecallParamsType = Static<typeof RecallParams>;

const ReflectParams = Type.Object({
  query: Type.String({
    description: "Question for Hindsight to answer using memory.",
  }),
  context: Type.Optional(
    Type.String({ description: "Additional context to guide reflection." }),
  ),
  budget: Type.Optional(
    StringEnum(BUDGETS, { description: "Reflect budget: low, mid, or high." }),
  ),
  tags: Type.Optional(Type.Array(Type.String({ description: "Tag filter." }))),
});

type ReflectParamsType = Static<typeof ReflectParams>;

const SaveInsightParams = Type.Object({
  content: Type.String({
    description:
      "Durable insight to save, written as a concrete fact, preference, decision, correction, or workflow habit.",
  }),
  context: Type.Optional(
    Type.String({ description: "Where this information came from." }),
  ),
  category: Type.Optional(
    Type.String({
      description: "Optional category, e.g. preferences, workflow, code-style.",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String({ description: "Additional tags to attach." })),
  ),
});

type SaveInsightParamsType = Static<typeof SaveInsightParams>;

export default function (pi: ExtensionAPI) {
  if (!config.enabled) return;

  pi.registerMessageRenderer(
    "hindsight-auto-recall",
    (message, { expanded }, theme) =>
      renderAutoRecallMessage(
        message.details as Partial<AutoRecallMessageDetails> | undefined,
        typeof message.content === "string"
          ? message.content
          : "Hindsight recall status",
        expanded,
        theme,
      ),
  );

  pi.on("session_start", async (_event, ctx) => {
    sessionTag = sanitizePath(ctx.cwd);
    currentBankId = deriveBankId(ctx.cwd);
    cachedContext = null;
    cachedMentalModelContext = null;
    turnCounter = 0;
    pendingWrites = [];
    pendingAutoRecall = null;
    eagerMentalModelContextPromise = null;

    try {
      client = new HindsightClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey || undefined,
        userAgent: "pi-hindsight-extension/0.1.0",
      });
      await ensureBank(client, currentBankId);
      enabled = true;
      if (config.injectContext && config.injectMentalModels) {
        startEagerMentalModelContextFetch();
      }
      setHindsightStatus(ctx, "connected");
    } catch (error) {
      enabled = false;
      client = null;
      const message =
        error instanceof Error ? describeError(error) : String(error);
      ctx.ui.notify(
        `Hindsight: unreachable (${message}), memory disabled for this session`,
        "warning",
      );
      setHindsightStatus(ctx, "unavailable");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || !config.injectContext) return;

    turnCounter++;
    if (isSubagent() && !config.autoRecallInSubagents) return;

    const shouldRefresh =
      turnCounter === 1 ||
      (config.refreshInterval > 0 &&
        turnCounter % config.refreshInterval === 0);

    if (turnCounter === 1 && eagerMentalModelContextPromise) {
      await resolveWithDeadline(
        eagerMentalModelContextPromise,
        config.autoRecallDeadlineMs,
      );
    }

    if (shouldRefresh) {
      const recentConversation = collectRecentConversation(
        ctx.sessionManager.getBranch() as SessionMessageEntryLike[],
        event.prompt,
      );
      const recallQuery = buildAutoRecallQuery(
        event.prompt,
        ctx.cwd,
        recentConversation,
      );
      const runAutoRecall = async (): Promise<{
        recallResult: AutoRecallResult;
        usedCachedContext: boolean;
      }> => {
        setHindsightStatus(ctx, "recalling");
        const recallResult = await fetchHindsightContext(
          recallQuery,
          ctx.signal,
        );
        const usedCachedContext =
          recallResult.status === "failed" && cachedContext !== null;

        if (recallResult.status !== "failed") {
          cachedContext = recallResult.context;
        }

        if (recallResult.status === "failed") {
          setHindsightStatus(ctx, "unavailable");
        } else {
          setHindsightStatus(ctx, "recalled");
        }

        return { recallResult, usedCachedContext };
      };

      if (!pendingAutoRecall) {
        const recallRun = runAutoRecall();
        pendingAutoRecall = recallRun
          .then(() => undefined)
          .catch(() => {
            setHindsightStatus(ctx, "unavailable");
          })
          .finally(() => {
            pendingAutoRecall = null;
          });

        const deadlineResult = await resolveWithDeadline(
          recallRun,
          config.autoRecallDeadlineMs,
        );
        if (deadlineResult.status === "completed") {
          sendAutoRecallMessage(
            pi,
            deadlineResult.value.recallResult,
            deadlineResult.value.usedCachedContext,
            true,
          );
        } else {
          recallRun
            .then(({ recallResult }) => {
              notifyAutoRecallResult(ctx, recallResult);
            })
            .catch(() => undefined);
        }
      }
    }

    const injectedContext = getInjectedContext();
    if (!injectedContext) return;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## User Memory (Hindsight)\nThe following context was loaded from Hindsight for this turn. It may include stable mental models from session startup and task-specific recalled memories:\n\n${injectedContext}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled || !client || !config.storeMessages) return;
    if (
      config.retainEveryNTurns > 1 &&
      turnCounter % config.retainEveryNTurns !== 0
    )
      return;

    const memory = buildMessageMemory(event.messages);
    if (!memory) return;

    const retainedAt = new Date().toISOString();
    const write = client
      .retain(currentBankId, memory, {
        timestamp: retainedAt,
        context: config.retainContext,
        documentId: `${sessionTag}-${turnCounter}`,
        metadata: {
          cwd: ctx.cwd,
          session_id: sessionTag,
          turn: String(turnCounter),
          retained_at: retainedAt,
        },
        tags: memoryTags(["kind:turn"]),
        async: config.writeAsync,
      })
      .then(() => undefined)
      .catch(() => {
        setHindsightStatus(ctx, "unavailable");
      });

    pendingWrites.push(write);
  });

  pi.on("session_shutdown", async () => {
    if (!enabled) return;
    await Promise.allSettled(pendingWrites);
    pendingWrites = [];
  });

  pi.registerTool<typeof RecallParams, RecallDetails>({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: `Recall relevant memories from Hindsight. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} if needed.`,
    promptSnippet: "Recall relevant memories from Hindsight long-term memory",
    promptGuidelines: [
      "Use hindsight_recall proactively before answering questions about past conversations, user preferences, project history, or any topic where prior context would help.",
    ],
    parameters: RecallParams,
    async execute(_toolCallId, params: RecallParamsType, signal) {
      if (!enabled || !client) {
        return {
          content: [{ type: "text", text: "Hindsight is not connected" }],
          details: {
            status: "unavailable",
            query: params.query,
            resultCount: 0,
          } satisfies RecallDetails,
        };
      }

      const response = await client.recall(currentBankId, params.query, {
        types: normalizeMemoryTypes(params.types ?? config.recallTypes),
        budget: params.budget ?? normalizeBudget(config.recallBudget, "mid"),
        maxTokens: params.maxTokens ?? config.recallMaxTokens,
        includeEntities: config.recallIncludeEntities,
        tags:
          params.tags ??
          (config.recallTags.length > 0 ? config.recallTags : undefined),
        tagsMatch: normalizeTagsMatch(config.recallTagsMatch),
        signal,
      });
      const fullText = formatRecallResponse(response) || "No memories found";
      const truncated = await truncateForTool(fullText, "hindsight-recall");
      const details: RecallDetails = {
        status: "ok",
        query: params.query,
        resultCount: response.results.length,
        outputChars: truncated.text.length,
        truncation: truncated.truncation,
        fullOutputPath: truncated.fullOutputPath,
      };

      return {
        content: [{ type: "text", text: truncated.text }],
        details,
      };
    },
    renderCall(args, theme) {
      return renderHindsightCall("hindsight_recall", args.query, theme);
    },
    renderResult: renderRecallResult,
  });

  pi.registerTool<typeof ReflectParams, ReflectDetails>({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description:
      "Ask Hindsight to synthesize an answer using long-term memory.",
    promptSnippet:
      "Ask Hindsight to synthesize an answer from long-term memory",
    promptGuidelines: [
      "Use hindsight_reflect when you need a synthesized answer grounded in Hindsight memory.",
    ],
    parameters: ReflectParams,
    async execute(_toolCallId, params: ReflectParamsType, signal) {
      if (!enabled || !client) {
        const details: ReflectDetails = {
          status: "unavailable",
          query: params.query,
        };
        return {
          content: [{ type: "text", text: "Hindsight is not connected" }],
          details,
        };
      }

      const response = await client.reflect(currentBankId, params.query, {
        context: params.context,
        budget: params.budget ?? normalizeBudget(config.recallBudget, "mid"),
        tags:
          params.tags ??
          (config.recallTags.length > 0 ? config.recallTags : undefined),
        factTypes: normalizeMemoryTypes(config.recallTypes),
        signal,
      });
      const truncated = await truncateForTool(
        response.text || "No response",
        "hindsight-reflect",
      );
      const details: ReflectDetails = {
        status: "ok",
        query: params.query,
        outputChars: truncated.text.length,
        truncation: truncated.truncation,
        fullOutputPath: truncated.fullOutputPath,
      };

      return {
        content: [{ type: "text", text: truncated.text }],
        details,
      };
    },
    renderCall(args, theme) {
      return renderHindsightCall("hindsight_reflect", args.query, theme);
    },
    renderResult: renderReflectResult,
  });

  pi.registerTool<typeof SaveInsightParams, RetainDetails>({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description:
      "Store information in Hindsight long-term memory. Use this to remember important facts, user preferences, project context, decisions, and anything worth recalling in future sessions.",
    promptSnippet: "Store information in Hindsight long-term memory",
    promptGuidelines: [
      "Use hindsight_retain to save important facts, user preferences, project context, and decisions that should be recalled in future sessions.",
      "Make hindsight_retain content specific and self-contained, including who, what, when, and why when relevant.",
    ],
    parameters: SaveInsightParams,
    async execute(_toolCallId, params: SaveInsightParamsType, signal) {
      if (!enabled || !client) {
        return {
          content: [{ type: "text", text: "Hindsight is not connected" }],
          details: {
            status: "unavailable",
            bankId: currentBankId,
            tags: [] as string[],
          },
        };
      }

      const tags = memoryTags([
        "kind:manual",
        ...(params.category ? [`category:${params.category}`] : []),
        ...(params.tags ?? []),
      ]);

      await client.retain(currentBankId, params.content, {
        timestamp: new Date(),
        context: params.context ?? config.retainContext,
        tags,
        async: config.writeAsync,
        signal,
      });

      return {
        content: [{ type: "text", text: "Memory stored successfully." }],
        details: {
          status: "ok",
          bankId: currentBankId,
          tags,
          contentChars: params.content.length,
          category: params.category,
        },
      };
    },
    renderCall(args, theme) {
      return renderHindsightCall("hindsight_retain", args.content, theme);
    },
    renderResult: renderRetainResult,
  });

  pi.registerTool<typeof SaveInsightParams, RetainDetails>({
    name: "hindsight_save_insight",
    label: "Hindsight Save Insight",
    description:
      "Persist a durable insight to Hindsight memory. Use for concrete user preferences, workflow habits, corrections, technical decisions, and project facts.",
    promptSnippet: "Save a durable insight to Hindsight long-term memory",
    promptGuidelines: [
      "Use hindsight_save_insight proactively when the user expresses a durable preference, correction, workflow habit, technical decision, or reusable project fact.",
      "Write hindsight_save_insight content as concrete facts, not vague summaries.",
    ],
    parameters: SaveInsightParams,
    async execute(_toolCallId, params: SaveInsightParamsType, signal) {
      if (!enabled || !client) {
        return {
          content: [{ type: "text", text: "Hindsight is not connected" }],
          details: {
            status: "unavailable",
            bankId: currentBankId,
            tags: [] as string[],
          },
        };
      }

      const tags = memoryTags([
        "kind:insight",
        ...(params.category ? [`category:${params.category}`] : []),
        ...(params.tags ?? []),
      ]);

      await client.retain(currentBankId, params.content, {
        timestamp: new Date(),
        context:
          params.context ??
          (params.category
            ? `Manual Pi insight (${params.category})`
            : "Manual Pi insight"),
        tags,
        async: config.writeAsync,
        signal,
      });

      return {
        content: [{ type: "text", text: "Insight saved to Hindsight." }],
        details: {
          status: "ok",
          bankId: currentBankId,
          tags,
          contentChars: params.content.length,
          category: params.category,
        },
      };
    },
    renderCall(args, theme) {
      return renderHindsightCall("hindsight_save_insight", args.content, theme);
    },
    renderResult: renderRetainResult,
  });

  pi.registerCommand("hindsight:status", {
    description: "Show Hindsight connection status and current memory bank",
    handler: async (_args, ctx) => {
      const status = getStatus();
      const lines = [
        `${HINDSIGHT_STATUS_ICON} Hindsight Status`,
        `  Connected: ${status.connected ? "yes" : "no"}`,
        `  Base URL: ${status.baseUrl}`,
        `  Bank: ${status.bankId}`,
        `  Session tag: ${status.sessionTag}`,
        `  Turn: ${status.turnCounter}`,
        `  Cached context: ${status.cachedContextChars} chars`,
        `  Pending writes: ${status.pendingWrites}`,
      ];
      ctx.ui.notify(lines.join("\n"), status.connected ? "info" : "warning");
    },
  });

  pi.registerCommand("hindsight:save", {
    description: "Save a durable memory to Hindsight",
    handler: async (args, ctx) => {
      if (!enabled || !client) {
        ctx.ui.notify("Hindsight is not connected", "error");
        return;
      }

      const content = args.trim();
      if (!content) {
        ctx.ui.notify("Usage: /hindsight:save <durable memory>", "info");
        return;
      }

      try {
        await client.retain(currentBankId, content, {
          timestamp: new Date(),
          context: "Manual Pi slash-command memory",
          tags: memoryTags(["kind:manual"]),
          async: config.writeAsync,
        });
        ctx.ui.notify(`✓ Saved to Hindsight: "${content}"`, "info");
      } catch (error) {
        const message =
          error instanceof Error ? describeError(error) : String(error);
        ctx.ui.notify(`Failed to save to Hindsight: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("hindsight:recall", {
    description: "Recall raw Hindsight memories for a query",
    handler: async (args, ctx) => {
      if (!enabled || !client) {
        ctx.ui.notify("Hindsight is not connected", "error");
        return;
      }

      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /hindsight:recall <query>", "info");
        return;
      }

      try {
        const response = await client.recall(currentBankId, query, {
          budget: normalizeBudget(config.recallBudget, "mid"),
          maxTokens: config.recallMaxTokens,
          types: normalizeMemoryTypes(config.recallTypes),
          includeEntities: config.recallIncludeEntities,
          tags: config.recallTags.length > 0 ? config.recallTags : undefined,
          tagsMatch:
            config.recallTags.length > 0
              ? normalizeTagsMatch(config.recallTagsMatch)
              : undefined,
        });
        ctx.ui.notify(
          formatRecallResponse(response) || "No memories found",
          "info",
        );
      } catch (error) {
        const message =
          error instanceof Error ? describeError(error) : String(error);
        ctx.ui.notify(`Hindsight recall failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("hindsight:reflect", {
    description: "Ask Hindsight to answer a query from memory",
    handler: async (args, ctx) => {
      if (!enabled || !client) {
        ctx.ui.notify("Hindsight is not connected", "error");
        return;
      }

      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /hindsight:reflect <query>", "info");
        return;
      }

      try {
        const response = await client.reflect(currentBankId, query, {
          budget: normalizeBudget(config.recallBudget, "mid"),
          factTypes: normalizeMemoryTypes(config.recallTypes),
          tags: config.recallTags.length > 0 ? config.recallTags : undefined,
        });
        ctx.ui.notify(response.text || "No response", "info");
      } catch (error) {
        const message =
          error instanceof Error ? describeError(error) : String(error);
        ctx.ui.notify(`Hindsight reflect failed: ${message}`, "error");
      }
    },
  });
}
