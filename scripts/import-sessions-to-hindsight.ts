#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

const DEFAULT_BASE_URL = "http://localhost:8888";
const DEFAULT_BANK_ID = "pi";
const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MENTAL_MODELS = [
  {
    id: "developer-preferences",
    name: "Developer Preferences",
    sourceQuery:
      "What are the developer's preferences for tools, libraries, coding style, and workflow? How do they like code to be written and reviewed?",
  },
  {
    id: "project-context",
    name: "Project Context",
    sourceQuery:
      "What is the project's tech stack, architecture, and key conventions? What are the main components and how do they fit together?",
  },
] as const;

interface CliOptions {
  sessionsDir: string;
  baseUrl: string;
  bankId: string;
  apiKey?: string;
  dryRun: boolean;
  limit?: number;
  projectContains?: string;
  since?: Date;
  until?: Date;
  concurrency: number;
  maxChars: number;
  includeToolResults: boolean;
  sync: boolean;
}

interface SessionMessage {
  role: "user" | "assistant" | "toolResult";
  content: string;
  toolName?: string;
}

interface ParsedSession {
  file: string;
  sessionId: string;
  cwd: string;
  startedAt: string;
  messages: SessionMessage[];
}

interface ImportChunk {
  session: ParsedSession;
  chunkIndex: number;
  chunkCount: number;
  transcript: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

function isRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== undefined && isRecord(value) ? value : undefined;
}

function asArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
    baseUrl: process.env.HINDSIGHT_API_URL || DEFAULT_BASE_URL,
    bankId: process.env.HINDSIGHT_BANK_ID || DEFAULT_BANK_ID,
    apiKey: process.env.HINDSIGHT_API_TOKEN || undefined,
    dryRun: true,
    concurrency: DEFAULT_CONCURRENCY,
    maxChars: DEFAULT_MAX_CHARS,
    includeToolResults: false,
    sync: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    const requireValue = (): string => {
      if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      index++;
      return next;
    };

    if (arg === "--sessions-dir") options.sessionsDir = expandHome(requireValue());
    else if (arg === "--base-url") options.baseUrl = requireValue();
    else if (arg === "--bank-id") options.bankId = requireValue();
    else if (arg === "--api-key") options.apiKey = requireValue();
    else if (arg === "--write") options.dryRun = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--limit") options.limit = Number.parseInt(requireValue(), 10);
    else if (arg === "--project") options.projectContains = requireValue();
    else if (arg === "--since") options.since = new Date(requireValue());
    else if (arg === "--until") options.until = new Date(requireValue());
    else if (arg === "--concurrency") options.concurrency = Number.parseInt(requireValue(), 10);
    else if (arg === "--max-chars") options.maxChars = Number.parseInt(requireValue(), 10);
    else if (arg === "--include-tool-results") options.includeToolResults = true;
    else if (arg === "--sync") options.sync = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isFinite(options.maxChars) || options.maxChars < 1000) {
    throw new Error("--max-chars must be at least 1000");
  }
  if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (options.since && Number.isNaN(options.since.getTime())) throw new Error("Invalid --since date");
  if (options.until && Number.isNaN(options.until.getTime())) throw new Error("Invalid --until date");

  return options;
}

function printHelp(): void {
  console.log(`Import Pi JSONL sessions into Hindsight.

Usage:
  bun scripts/import-sessions-to-hindsight.ts [options]

Safe by default: runs in dry-run mode unless --write is passed.

Options:
  --sessions-dir <path>       Session root (default: ~/.pi/agent/sessions)
  --base-url <url>            Hindsight API URL (default: ${DEFAULT_BASE_URL})
  --bank-id <id>              Hindsight bank ID (default: ${DEFAULT_BANK_ID})
  --api-key <token>           Optional bearer token
  --write                     Actually retain memories (default is dry-run)
  --dry-run                   Preview only
  --limit <n>                 Import at most n sessions
  --project <substring>       Only sessions whose cwd/path contains substring
  --since <date>              Only sessions at or after date
  --until <date>              Only sessions before date
  --concurrency <n>           Parallel retain requests (default: ${DEFAULT_CONCURRENCY})
  --max-chars <n>             Max transcript chars per retained document (default: ${DEFAULT_MAX_CHARS})
  --include-tool-results      Include toolResult text (off by default)
  --sync                      Use synchronous Hindsight retain processing
  --help                      Show this help

Examples:
  bun scripts/import-sessions-to-hindsight.ts --limit 5
  bun scripts/import-sessions-to-hindsight.ts --project pi-config --write
  bun scripts/import-sessions-to-hindsight.ts --sessions-dir ~/.pi-personal/agent/sessions --write
`);
}

async function findSessionFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(path);
      }
    }
  }

  await walk(root);
  return found.sort();
}

function extractText(content: JsonValue | undefined): string {
  if (typeof content === "string") return stripMemoryTags(content).trim();
  const blocks = asArray(content);
  if (!blocks) return "";

  const parts: string[] = [];
  for (const blockValue of blocks) {
    const block = isRecord(blockValue) ? blockValue : undefined;
    if (!block) continue;
    if (block.type === "text") {
      const text = asString(block.text)?.trim();
      if (text) parts.push(text);
    }
  }

  return stripMemoryTags(parts.join("\n")).trim();
}

function stripMemoryTags(content: string): string {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "");
}

async function parseSession(file: string, includeToolResults: boolean): Promise<ParsedSession | null> {
  const raw = await readFile(file, "utf8");
  const messages: SessionMessage[] = [];
  let cwd = dirname(file);
  let sessionId = basename(file, ".jsonl");
  let startedAt = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: JsonValue;
    try {
      entry = JSON.parse(trimmed) as JsonValue;
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    const type = asString(entry.type);
    if (type === "session") {
      cwd = asString(entry.cwd) ?? cwd;
      sessionId = asString(entry.id) ?? sessionId;
      startedAt = asString(entry.timestamp) ?? startedAt;
      continue;
    }

    if (type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    const role = asString(message.role);
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    if (role === "toolResult" && !includeToolResults) continue;

    const text = extractText(message.content);
    if (!text) continue;

    messages.push({
      role,
      content: text,
      toolName: asString(message.toolName),
    });
  }

  const conversationalMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (conversationalMessages.length === 0) return null;

  if (!startedAt) {
    const fileStat = await stat(file);
    startedAt = fileStat.mtime.toISOString();
  }

  return { file, sessionId, cwd, startedAt, messages };
}

function formatSessionTranscript(session: ParsedSession): string {
  const parts: string[] = [];
  for (const message of session.messages) {
    if (message.role === "toolResult") {
      const toolName = message.toolName ? `:${message.toolName}` : "";
      parts.push(`[role: toolResult${toolName}]\n${message.content}\n[toolResult:end]`);
    } else {
      parts.push(`[role: ${message.role}]\n${message.content}\n[${message.role}:end]`);
    }
  }
  return parts.join("\n\n");
}

function splitTranscript(session: ParsedSession, maxChars: number): ImportChunk[] {
  const chunks: ImportChunk[] = [];
  let current = "";
  let chunkIndex = 0;

  for (const message of session.messages) {
    const formatted =
      message.role === "toolResult"
        ? `[role: toolResult${message.toolName ? `:${message.toolName}` : ""}]\n${message.content}\n[toolResult:end]`
        : `[role: ${message.role}]\n${message.content}\n[${message.role}:end]`;

    if (current.length > 0 && current.length + formatted.length + 2 > maxChars) {
      chunks.push({ session, chunkIndex, chunkCount: 0, transcript: current });
      chunkIndex++;
      current = "";
    }

    if (formatted.length > maxChars) {
      const slices = chunkLongMessage(formatted, maxChars);
      for (const slice of slices) {
        if (current.length > 0) {
          chunks.push({ session, chunkIndex, chunkCount: 0, transcript: current });
          chunkIndex++;
          current = "";
        }
        chunks.push({ session, chunkIndex, chunkCount: 0, transcript: slice });
        chunkIndex++;
      }
      continue;
    }

    current = current ? `${current}\n\n${formatted}` : formatted;
  }

  if (current) chunks.push({ session, chunkIndex, chunkCount: 0, transcript: current });
  return chunks.map((chunk) => ({ ...chunk, chunkCount: chunks.length }));
}

function chunkLongMessage(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}

function sessionDocumentId(session: ParsedSession, chunk: ImportChunk): string {
  const hash = createHash("sha256").update(session.file).digest("hex").slice(0, 16);
  const suffix = chunk.chunkCount > 1 ? `-c${chunk.chunkIndex}` : "";
  return `pi-session-${session.sessionId}-${hash}${suffix}`;
}

function projectTag(cwd: string): string {
  const project = basename(cwd) || "unknown";
  return `project:${project.replace(/[^A-Za-z0-9_.:-]+/g, "-")}`;
}

async function ensureBank(options: CliOptions): Promise<void> {
  const response = await fetch(`${options.baseUrl}/v1/default/banks/${encodeURIComponent(options.bankId)}`, {
    method: "PUT",
    headers: requestHeaders(options),
    body: JSON.stringify({
      name: "pi",
      reflect_mission:
        "You are pi, a coding agent. Use memories to answer questions about the user's durable preferences, workflow, projects, and previous technical decisions.",
      retain_mission:
        "Extract durable software engineering preferences, workflow habits, project facts, technical decisions, corrections, and task outcomes. Ignore transient command output and low-level tool noise unless it changes future behavior.",
      enable_observations: true,
      observations_mission:
        "Synthesize stable observations about the user, projects, preferences, workflows, and technical decisions that will help future coding-agent sessions.",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create/update bank ${options.bankId}: HTTP ${response.status} ${await response.text()}`);
  }

  await ensureDefaultMentalModels(options);
}

async function ensureDefaultMentalModels(options: CliOptions): Promise<void> {
  for (const model of DEFAULT_MENTAL_MODELS) {
    const getResponse = await fetch(
      `${options.baseUrl}/v1/default/banks/${encodeURIComponent(options.bankId)}/mental-models/${model.id}`,
      { headers: requestHeaders(options) },
    );

    if (getResponse.ok) {
      const updateResponse = await fetch(
        `${options.baseUrl}/v1/default/banks/${encodeURIComponent(options.bankId)}/mental-models/${model.id}`,
        {
          method: "PATCH",
          headers: requestHeaders(options),
          body: JSON.stringify({
            name: model.name,
            source_query: model.sourceQuery,
            trigger: { refresh_after_consolidation: true },
          }),
        },
      );
      if (!updateResponse.ok) {
        throw new Error(
          `Failed to update mental model ${model.id}: HTTP ${updateResponse.status} ${await updateResponse.text()}`,
        );
      }
      continue;
    }

    if (getResponse.status !== 404) {
      throw new Error(
        `Failed to read mental model ${model.id}: HTTP ${getResponse.status} ${await getResponse.text()}`,
      );
    }

    const createResponse = await fetch(
      `${options.baseUrl}/v1/default/banks/${encodeURIComponent(options.bankId)}/mental-models`,
      {
        method: "POST",
        headers: requestHeaders(options),
        body: JSON.stringify({
          id: model.id,
          name: model.name,
          source_query: model.sourceQuery,
          trigger: { refresh_after_consolidation: true },
        }),
      },
    );

    if (!createResponse.ok && createResponse.status !== 409) {
      throw new Error(
        `Failed to create mental model ${model.id}: HTTP ${createResponse.status} ${await createResponse.text()}`,
      );
    }
  }
}

async function retainChunk(options: CliOptions, chunk: ImportChunk): Promise<void> {
  const session = chunk.session;
  const importedAt = new Date().toISOString();
  const documentId = sessionDocumentId(session, chunk);
  const response = await fetch(
    `${options.baseUrl}/v1/default/banks/${encodeURIComponent(options.bankId)}/memories`,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: JSON.stringify({
        async: !options.sync,
        items: [
          {
            content: chunk.transcript,
            context: "pi-session-import",
            document_id: documentId,
            timestamp: session.startedAt,
            tags: [
              "source:pi-session-import",
              "kind:historical-session",
              `session:${session.sessionId}`,
              `bank:${options.bankId}`,
              projectTag(session.cwd),
            ],
            metadata: {
              file: session.file,
              relative_file: relative(options.sessionsDir, session.file),
              cwd: session.cwd,
              session_id: session.sessionId,
              started_at: session.startedAt,
              imported_at: importedAt,
              message_count: String(session.messages.length),
              chunk_index: String(chunk.chunkIndex),
              chunk_count: String(chunk.chunkCount),
            },
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Retain failed for ${session.file}: HTTP ${response.status} ${await response.text()}`);
  }
}

function requestHeaders(options: CliOptions): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  return headers;
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex++;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function shouldKeepSession(session: ParsedSession, options: CliOptions): boolean {
  if (options.projectContains) {
    const needle = options.projectContains.toLowerCase();
    if (!session.cwd.toLowerCase().includes(needle) && !session.file.toLowerCase().includes(needle)) {
      return false;
    }
  }

  const started = new Date(session.startedAt);
  if (options.since && started < options.since) return false;
  if (options.until && started >= options.until) return false;
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const files = await findSessionFiles(options.sessionsDir);
  const sessions: ParsedSession[] = [];

  for (const file of files) {
    const session = await parseSession(file, options.includeToolResults);
    if (!session || !shouldKeepSession(session, options)) continue;
    sessions.push(session);
    if (options.limit && sessions.length >= options.limit) break;
  }

  const chunks = sessions.flatMap((session) => splitTranscript(session, options.maxChars));
  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.transcript.length, 0);

  console.log(
    `${options.dryRun ? "Dry run" : "Import"}: ${sessions.length} sessions, ${chunks.length} documents, ${totalChars.toLocaleString()} chars → ${options.baseUrl} bank ${options.bankId}`,
  );

  if (sessions.length === 0) return;

  if (options.dryRun) {
    for (const session of sessions.slice(0, 10)) {
      const transcript = formatSessionTranscript(session);
      console.log(
        `- ${relative(options.sessionsDir, session.file)} | ${session.messages.length} messages | ${transcript.length.toLocaleString()} chars | ${session.cwd}`,
      );
    }
    if (sessions.length > 10) console.log(`... ${sessions.length - 10} more sessions`);
    console.log("Run again with --write to import.");
    return;
  }

  await ensureBank(options);
  let completed = 0;
  await runPool(chunks, options.concurrency, async (chunk) => {
    await retainChunk(options, chunk);
    completed++;
    if (completed % 25 === 0 || completed === chunks.length) {
      console.log(`Imported ${completed}/${chunks.length} documents`);
    }
  });

  console.log(`✓ Imported ${sessions.length} sessions as ${chunks.length} Hindsight documents.`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
}
