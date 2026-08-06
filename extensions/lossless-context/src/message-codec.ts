import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens as estimatePiMessageTokens } from "@earendil-works/pi-coding-agent";
import type { DecodedStoredMessage, MessageRecord } from "./types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isTextOrImageBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "text") return isString(value.text);
  if (value.type === "image") {
    return isString(value.data) && isString(value.mimeType);
  }
  return false;
}

function isAssistantBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "text") return isString(value.text);
  if (value.type === "thinking") return isString(value.thinking);
  if (value.type === "toolCall") {
    return (
      isString(value.id) &&
      isString(value.name) &&
      isObject(value.arguments)
    );
  }
  return false;
}

function isStopReason(value: unknown): boolean {
  return (
    value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
  );
}

function isUsage(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.cost)) return false;
  return (
    isFiniteNumber(value.input) &&
    isFiniteNumber(value.output) &&
    isFiniteNumber(value.cacheRead) &&
    isFiniteNumber(value.cacheWrite) &&
    isFiniteNumber(value.totalTokens) &&
    isFiniteNumber(value.cost.input) &&
    isFiniteNumber(value.cost.output) &&
    isFiniteNumber(value.cost.cacheRead) &&
    isFiniteNumber(value.cost.cacheWrite) &&
    isFiniteNumber(value.cost.total)
  );
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isObject(value) || !isString(value.role)) return false;
  if (!isFiniteNumber(value.timestamp)) return false;

  switch (value.role) {
    case "user":
      return (
        isString(value.content) ||
        (Array.isArray(value.content) && value.content.every(isTextOrImageBlock))
      );

    case "assistant":
      return (
        Array.isArray(value.content) &&
        value.content.every(isAssistantBlock) &&
        isString(value.api) &&
        isString(value.provider) &&
        isString(value.model) &&
        isUsage(value.usage) &&
        isStopReason(value.stopReason) &&
        isOptionalString(value.responseModel) &&
        isOptionalString(value.responseId) &&
        isOptionalString(value.errorMessage)
      );

    case "toolResult":
      return (
        isString(value.toolCallId) &&
        isString(value.toolName) &&
        Array.isArray(value.content) &&
        value.content.every(isTextOrImageBlock) &&
        typeof value.isError === "boolean" &&
        (value.addedToolNames === undefined ||
          (Array.isArray(value.addedToolNames) &&
            value.addedToolNames.every(isString)))
      );

    case "bashExecution":
      return (
        isString(value.command) &&
        isString(value.output) &&
        (value.exitCode === undefined || isFiniteNumber(value.exitCode)) &&
        typeof value.cancelled === "boolean" &&
        typeof value.truncated === "boolean" &&
        isOptionalString(value.fullOutputPath) &&
        (value.excludeFromContext === undefined ||
          typeof value.excludeFromContext === "boolean")
      );

    case "custom":
      return (
        isString(value.customType) &&
        (isString(value.content) ||
          (Array.isArray(value.content) &&
            value.content.every(isTextOrImageBlock))) &&
        typeof value.display === "boolean"
      );

    case "branchSummary":
      return isString(value.summary) && isString(value.fromId);

    case "compactionSummary":
      return isString(value.summary) && isFiniteNumber(value.tokensBefore);

    default:
      return false;
  }
}

/** Serialize with the same JSON semantics used by Pi session persistence. */
export function serializeCanonicalMessage(message: AgentMessage): string {
  return JSON.stringify(message);
}

/** Parse and structurally validate canonical data without leaking its contents. */
export function deserializeCanonicalMessage(
  canonicalJson: string,
  localMessageId: string,
): AgentMessage {
  try {
    const parsed: unknown = JSON.parse(canonicalJson);
    if (!isAgentMessage(parsed)) throw new Error("invalid message shape");
    return parsed;
  } catch {
    throw new Error(`Corrupt canonical LCM message row ${localMessageId}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isObject(value)) {
    const properties = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${properties.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function projectContent(content: unknown): string[] {
  if (isString(content)) return [content];
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && isString(block.text)) {
      lines.push(block.text);
    } else if (block.type === "image" && isString(block.mimeType)) {
      lines.push(`[image: ${block.mimeType}]`);
    } else if (block.type === "thinking" && isString(block.thinking)) {
      lines.push(`[thinking] ${block.thinking}`);
    } else if (
      block.type === "toolCall" &&
      isString(block.name) &&
      isString(block.id)
    ) {
      lines.push(
        `[tool call: ${block.name} id=${block.id}] ${stableJson(block.arguments)}`,
      );
    }
  }
  return lines;
}

/** Build deterministic human-readable text for search and summary prompts. */
export function projectMessageSearchText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
    case "assistant":
      return projectContent(message.content).join("\n");

    case "toolResult":
      return [
        `[tool result: ${message.toolName} id=${message.toolCallId}${message.isError ? " error" : ""}]`,
        ...projectContent(message.content),
      ].join("\n");

    case "bashExecution":
      return [
        `[bash] ${message.command}`,
        message.output,
        `exit=${message.exitCode ?? "unknown"}`,
        message.cancelled ? "cancelled" : "",
        message.truncated ? "truncated" : "",
        message.fullOutputPath ? `full-output=${message.fullOutputPath}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n");

    case "custom":
      return [
        `[custom: ${message.customType}]`,
        ...projectContent(message.content),
      ].join("\n");

    case "branchSummary":
      return `[branch summary from=${message.fromId}]\n${message.summary}`;

    case "compactionSummary":
      return `[compaction summary tokens-before=${message.tokensBefore}]\n${message.summary}`;
  }
}

/** Represent irrecoverably flattened v1 data without fabricating its old role. */
export function createLegacyMessage(record: MessageRecord): AgentMessage {
  const timestamp = Date.parse(record.created_at);
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[Legacy ${record.role} projection; not an exact original]\n` +
          record.search_text,
      },
    ],
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
  };
}

export function decodeStoredMessage(
  record: MessageRecord,
): DecodedStoredMessage {
  if (record.canonical_json !== null) {
    return {
      kind: "canonical",
      record,
      message: deserializeCanonicalMessage(record.canonical_json, record.id),
    };
  }
  return {
    kind: "legacy",
    record,
    originalRole: record.role,
    message: createLegacyMessage(record),
  };
}

export interface EncodedCanonicalMessage {
  role: string;
  canonicalJson: string;
  searchText: string;
  tokenCount: number;
}

export function encodeCanonicalMessage(
  message: AgentMessage,
): EncodedCanonicalMessage {
  return {
    role: message.role,
    canonicalJson: serializeCanonicalMessage(message),
    searchText: projectMessageSearchText(message),
    tokenCount: estimatePiMessageTokens(message),
  };
}

export function renderCanonicalMessage(message: AgentMessage): string {
  return projectMessageSearchText(message) || `[${message.role}]`;
}
