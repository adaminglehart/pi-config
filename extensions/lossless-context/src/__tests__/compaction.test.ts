/**
 * Tests for CompactionEngine.
 * Uses the injectable `summarizeFn` dep for mocking instead of module-level mocks.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { setupTestDb, createStores, addMessages, makeConfig, makeModelRegistry } from "./helpers.js";
import { CompactionEngine } from "../compaction.js";
import type { LcmConfig } from "../types.js";

describe("CompactionEngine", () => {
  let db: DatabaseSync;
  let drizzleDb: import("../db/connection.js").DrizzleDB;
  let hasFts5: boolean;
  let conversationStore: ReturnType<typeof createStores>["conversationStore"];
  let summaryStore: ReturnType<typeof createStores>["summaryStore"];
  let contextItemsStore: ReturnType<typeof createStores>["contextItemsStore"];
  let conversationId: string;
  let summarizeCalls: Array<{ content: string; kind: string; depth: number }>;

  const mockSummarize = async (content: string, kind: string, depth: number) => {
    summarizeCalls.push({ content, kind: kind as string, depth });
    return "[MOCK SUMMARY]";
  };

  const makeEngine = (config: Partial<LcmConfig> = {}) =>
    new CompactionEngine({
      conversationStore,
      summaryStore,
      contextItemsStore,
      config: makeConfig(config),
      modelRegistry: makeModelRegistry(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      summarizeFn: mockSummarize as any,
    });

  beforeEach(() => {
    ({ db, drizzleDb, hasFts5 } = setupTestDb());
    ({ conversationStore, summaryStore, contextItemsStore } = createStores(drizzleDb, db, hasFts5));
    const convo = conversationStore.getOrCreateConversation("compaction-test");
    conversationId = convo.id;
    summarizeCalls = [];
  });

  describe("shouldCompact", () => {
    it("returns false when no context items", () => {
      const engine = makeEngine();
      assert.equal(engine.shouldCompact(conversationId, 100000), false);
    });

    it("returns false when total tokens are below threshold", () => {
      // 5 messages at 100 tokens = 500 total
      // threshold = 0.9 * 100000 = 90000 → 500 < 90000 → false
      addMessages(conversationStore, conversationId, 5, 100);
      const engine = makeEngine({
        freshTailCount: 10,
        freshTailMaxTokens: 1000000,
        leafChunkTokens: 1000,
        contextThreshold: 0.9,
      });
      assert.equal(engine.shouldCompact(conversationId, 100000), false);
    });

    it("returns true when total tokens exceed threshold", () => {
      // 10 messages at 1000 tokens each = 10000 total
      // threshold = 0.9 * 10000 = 9000 → 10000 > 9000 → true
      addMessages(conversationStore, conversationId, 10, 1000);
      const engine = makeEngine({
        freshTailCount: 100,
        freshTailMaxTokens: 1000000,
        contextThreshold: 0.9,
      });
      assert.equal(engine.shouldCompact(conversationId, 10000), true);
    });

    it("returns false when under threshold even with evictable messages", () => {
      // 10 messages at 200 tokens = 2000 total
      // freshTailCount=2 → 8 evictable = 1600 tokens
      // But total 2000 < threshold (0.99 * 1000000 = 990000) → false
      addMessages(conversationStore, conversationId, 10, 200);
      const engine = makeEngine({
        freshTailCount: 2,
        freshTailMaxTokens: 1000000,
        leafChunkTokens: 1000,
        contextThreshold: 0.99,
      });
      assert.equal(engine.shouldCompact(conversationId, 1000000), false);
    });

    it("fresh tail token cap limits what counts as fresh tail", () => {
      // 5 messages at 1000 tokens each = 5000 total
      // freshTailCount=10, freshTailMaxTokens=2500
      // → only 2 messages in fresh tail (2000 ≤ 2500, 3rd would be 3000 > 2500)
      // But this only affects what's evictable, not whether we trigger.
      // threshold = 0.5 * 5000 = 2500 → 5000 > 2500 → true
      addMessages(conversationStore, conversationId, 5, 1000);
      const engine = makeEngine({
        freshTailCount: 10,
        freshTailMaxTokens: 2500,
        leafChunkTokens: 1000,
        contextThreshold: 0.5,
      });
      assert.equal(engine.shouldCompact(conversationId, 5000), true);
    });
  });

  describe("runCompaction — leaf pass", () => {
    it("summarizes evictable messages and replaces them in context items", async () => {
      // 6 messages at 200 tokens, freshTailCount=2 → 4 evictable
      const msgs = addMessages(conversationStore, conversationId, 6, 200);
      const engine = makeEngine({
        freshTailCount: 2,
        freshTailMaxTokens: 1000000,
        leafMinFanout: 2,
        leafChunkTokens: 500,
        incrementalMaxDepth: 0, // no condensed pass
      });

      await engine.runCompaction(conversationId);

      const items = contextItemsStore.getContextItems(conversationId);
      const summaryItems = items.filter((i) => i.item_type === "summary");
      const messageItems = items.filter((i) => i.item_type === "message");

      assert.ok(summaryItems.length > 0);
      // Fresh tail (last 2 messages) should remain as message items
      assert.equal(messageItems.length, 2);
      assert.equal(messageItems[0].message_id, msgs[4].id);
      assert.equal(messageItems[1].message_id, msgs[5].id);
    });

    it("skips already-summarized messages in leaf pass", async () => {
      const msgs = addMessages(conversationStore, conversationId, 6, 200);

      const existingSummary = summaryStore.createLeafSummary(
        conversationId,
        "existing summary",
        50,
        [msgs[0].id, msgs[1].id],
      );
      contextItemsStore.replaceContextItems(conversationId, [0, 1], [
        { itemType: "summary", summaryId: existingSummary.id },
      ]);

      const engine = makeEngine({
        freshTailCount: 2,
        freshTailMaxTokens: 1000000,
        leafMinFanout: 2,
        leafChunkTokens: 500,
        incrementalMaxDepth: 0,
      });

      await engine.runCompaction(conversationId);

      // Verify summarize was called but NOT for msgs 0,1 (already summarized)
      for (const call of summarizeCalls) {
        assert.ok(!call.content.includes('"message 0"'));
        assert.ok(!call.content.includes('"message 1"'));
      }
    });

    it("runt chunk gets merged into previous chunk", async () => {
      addMessages(conversationStore, conversationId, 5, 200);

      const engine = makeEngine({
        freshTailCount: 1,
        freshTailMaxTokens: 1000000,
        leafMinFanout: 2,
        leafChunkTokens: 350,
        incrementalMaxDepth: 0,
      });

      await engine.runCompaction(conversationId);

      const leafCalls = summarizeCalls.filter((c) => c.kind === "leaf");
      assert.ok(leafCalls.length <= 2);
    });

    it("does not compact when evictable messages are below leafMinFanout", async () => {
      // 3 messages, freshTailCount=2 → 1 evictable
      // leafMinFanout=2 → 1 < 2 → no compaction
      addMessages(conversationStore, conversationId, 3, 200);
      const engine = makeEngine({
        freshTailCount: 2,
        freshTailMaxTokens: 1000000,
        leafMinFanout: 2,
        leafChunkTokens: 500,
        incrementalMaxDepth: 0,
      });

      await engine.runCompaction(conversationId);

      assert.equal(summarizeCalls.length, 0);
    });
  });

  describe("runCompaction — condensed pass", () => {
    it("fires condensed pass when enough leaf summaries exist", async () => {
      // 10 messages at 200 tokens → 8 evictable → ~4 chunks of 2
      addMessages(conversationStore, conversationId, 10, 200);

      const engine = makeEngine({
        freshTailCount: 2,
        freshTailMaxTokens: 1000000,
        leafMinFanout: 2,
        leafChunkTokens: 400,
        condensedMinFanout: 2,
        incrementalMaxDepth: 1,
      });

      await engine.runCompaction(conversationId);

      const leafCalls = summarizeCalls.filter((c) => c.kind === "leaf");
      const condensedCalls = summarizeCalls.filter((c) => c.kind === "condensed");

      assert.ok(leafCalls.length > 0);
      assert.ok(condensedCalls.length > 0);
    });

    it("does NOT fire condensed pass when fewer leaf summaries than condensedMinFanout", async () => {
      addMessages(conversationStore, conversationId, 6, 200);

      const engine = makeEngine({
        freshTailCount: 2,
        freshTailMaxTokens: 1000000,
        leafMinFanout: 2,
        leafChunkTokens: 800, // 4 msgs per chunk → 1 chunk
        condensedMinFanout: 3,
        incrementalMaxDepth: 1,
      });

      await engine.runCompaction(conversationId);

      const condensedCalls = summarizeCalls.filter((c) => c.kind === "condensed");
      assert.equal(condensedCalls.length, 0);
    });
  });
});
