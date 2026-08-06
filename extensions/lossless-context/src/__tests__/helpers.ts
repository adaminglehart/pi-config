import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LcmDatabase, type DrizzleDB } from "../db/connection.js";
import { ConversationStore } from "../store/conversation-store.js";
import { ContextItemsStore } from "../store/context-items-store.js";
import { SummaryStore } from "../store/summary-store.js";
import type { LcmConfig, MessageRecord } from "../types.js";

export function setupTestDb(): {
  db: DatabaseSync;
  drizzleDb: DrizzleDB;
  hasFts5: boolean;
} {
  const lcmDb = new LcmDatabase(":memory:");
  return {
    db: lcmDb.db,
    drizzleDb: lcmDb.drizzle,
    hasFts5: lcmDb.hasFts5,
  };
}

export function makeConfig(overrides: Partial<LcmConfig> = {}): LcmConfig {
  return {
    contextThreshold: 0.75,
    freshTailCount: 4,
    freshTailMaxTokens: 10000,
    softTokenThreshold: 0.65,
    hardTokenThreshold: 0.85,
    backgroundCompaction: true,
    leafMinFanout: 2,
    condensedMinFanout: 2,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 1,
    leafChunkTokens: 1000,
    leafTargetTokens: 200,
    condensedTargetTokens: 200,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25000,
    summaryProvider: "test",
    summaryModel: "test-model",
    expansionProvider: "",
    expansionModel: "",
    dbPath: ":memory:",
    enabled: true,
    summaryTimeoutMs: 60000,
    ...overrides,
  };
}

export function createStores(
  drizzleDb: DrizzleDB,
  db: DatabaseSync,
  hasFts5: boolean,
) {
  return {
    conversationStore: new ConversationStore(drizzleDb, db, hasFts5),
    summaryStore: new SummaryStore(drizzleDb, db, hasFts5),
    contextItemsStore: new ContextItemsStore(drizzleDb, db),
  };
}

export function makeUserMessage(
  content: string,
  timestamp = 1,
): AgentMessage {
  return { role: "user", content, timestamp };
}

export function makeAssistantMessage(
  text: string,
  timestamp = 1,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

export function addTestMessage(
  conversationStore: ConversationStore,
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  desiredTokens?: number,
  sessionEntryId = randomUUID(),
): MessageRecord {
  const targetLength = desiredTokens === undefined ? undefined : desiredTokens * 4;
  const content =
    targetLength === undefined
      ? text
      : text.slice(0, targetLength).padEnd(targetLength, "x");
  const message =
    role === "user"
      ? makeUserMessage(content)
      : makeAssistantMessage(content);
  return conversationStore.addMessage({
    conversationId,
    sessionEntryId,
    sessionParentEntryId: null,
    sessionEntryType: "message",
    message,
  }).message;
}

export function addMessages(
  conversationStore: ConversationStore,
  conversationId: string,
  count: number,
  tokensEach = 100,
): MessageRecord[] {
  const records: MessageRecord[] = [];
  for (let index = 0; index < count; index++) {
    records.push(
      addTestMessage(
        conversationStore,
        conversationId,
        index % 2 === 0 ? "user" : "assistant",
        `message ${index}`,
        tokensEach,
        `fixture-entry-${conversationId}-${index}-${randomUUID()}`,
      ),
    );
  }
  return records;
}

export function makeModelRegistry() {
  return {
    find: () => ({ id: "test-model", provider: "test" }),
    getApiKeyAndHeaders: async () => ({ apiKey: "test-key", headers: {} }),
  } as unknown as import("@earendil-works/pi-coding-agent").ModelRegistry;
}
