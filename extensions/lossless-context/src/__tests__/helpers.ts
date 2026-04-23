/**
 * Shared test helpers for lossless-context tests.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { LcmDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migration.js";
import { ConversationStore } from "../store/conversation-store.js";
import { SummaryStore } from "../store/summary-store.js";
import { ContextItemsStore } from "../store/context-items-store.js";
import type { LcmConfig } from "../types.js";

/**
 * Create an in-memory LcmDatabase-like object for testing.
 */
export function createTestDb(): { db: DatabaseSync; hasFts5: boolean } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");

  // Detect FTS5
  let hasFts5 = false;
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(content)");
    db.exec("DROP TABLE IF EXISTS _fts5_test");
    hasFts5 = true;
  } catch {
    hasFts5 = false;
  }

  return { db, hasFts5 };
}

/**
 * Run migrations on a test db.
 */
export function setupTestDb(): { db: DatabaseSync; hasFts5: boolean } {
  const { db, hasFts5 } = createTestDb();
  // runMigrations expects an LcmDatabase-like object
  runMigrations({ db, hasFts5 } as unknown as import("../db/connection.js").LcmDatabase);
  return { db, hasFts5 };
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
export function createStores(db: DatabaseSync, hasFts5: boolean) {
  return {
    conversationStore: new ConversationStore(db, hasFts5),
    summaryStore: new SummaryStore(db, hasFts5),
    contextItemsStore: new ContextItemsStore(db),
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
  const messages = [];
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
