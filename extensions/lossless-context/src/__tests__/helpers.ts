/**
 * Shared test helpers for lossless-context tests.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { LcmDatabase, type DrizzleDB } from "../db/connection.js";
import { ConversationStore } from "../store/conversation-store.js";
import { SummaryStore } from "../store/summary-store.js";
import { ContextItemsStore } from "../store/context-items-store.js";
import type { LcmConfig } from "../types.js";

/**
 * Create an in-memory LcmDatabase with all tables ready.
 */
export function setupTestDb(): { db: DatabaseSync; drizzleDb: DrizzleDB; hasFts5: boolean } {
  const lcmDb = new LcmDatabase(":memory:");
  return { db: lcmDb.db, drizzleDb: lcmDb.drizzle, hasFts5: lcmDb.hasFts5 };
}

/**
 * Default test config with small values for testing.
 */
export function makeConfig(overrides: Partial<LcmConfig> = {}): LcmConfig {
  return {
    contextThreshold: 0.75,
    freshTailCount: 4,
    freshTailMaxTokens: 10000,
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

/**
 * Create all three stores sharing a single test db.
 */
export function createStores(drizzleDb: DrizzleDB, db: DatabaseSync, hasFts5: boolean) {
  return {
    conversationStore: new ConversationStore(drizzleDb, db, hasFts5),
    summaryStore: new SummaryStore(drizzleDb, db, hasFts5),
    contextItemsStore: new ContextItemsStore(drizzleDb, db),
  };
}

/**
 * Add N messages to a conversation, returning their records.
 */
export function addMessages(
  conversationStore: ConversationStore,
  conversationId: string,
  count: number,
  tokensEach = 100,
): ReturnType<ConversationStore["addMessage"]>[] {
  const messages: ReturnType<ConversationStore["addMessage"]>[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      conversationStore.addMessage(
        conversationId,
        i % 2 === 0 ? "user" : "assistant",
        JSON.stringify(`message ${i}`),
        tokensEach,
      ),
    );
  }
  return messages;
}

/**
 * Stub ModelRegistry for testing.
 */
export function makeModelRegistry() {
  return {
    find: () => ({ id: "test-model", provider: "test" }),
    getApiKeyAndHeaders: async () => ({ apiKey: "test-key", headers: {} }),
  } as unknown as import("@mariozechner/pi-coding-agent").ModelRegistry;
}
