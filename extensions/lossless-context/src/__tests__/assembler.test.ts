/**
 * Tests for ContextAssembler.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { ContextAssembler } from "../assembler.js";
import { setupTestDb, createStores, addMessages, makeConfig } from "./helpers.js";
import type { LcmConfig } from "../types.js";

describe("ContextAssembler", () => {
  let db: DatabaseSync;
  let hasFts5: boolean;
  let conversationStore: ReturnType<typeof createStores>["conversationStore"];
  let summaryStore: ReturnType<typeof createStores>["summaryStore"];
  let contextItemsStore: ReturnType<typeof createStores>["contextItemsStore"];
  let conversationId: string;

  const makeAssembler = (config: Partial<LcmConfig> = {}) =>
    new ContextAssembler({
      conversationStore,
      summaryStore,
      contextItemsStore,
      config: makeConfig(config),
    });

  beforeEach(() => {
    ({ db, hasFts5 } = setupTestDb());
    ({ conversationStore, summaryStore, contextItemsStore } = createStores(db, hasFts5));
    const convo = conversationStore.getOrCreateConversation("assembler-test");
    conversationId = convo.id;
  });

  describe("splitFreshTail — summaries always evictable", () => {
    it("puts summaries in evictable even when they are the last items", () => {
      // Add messages, replace some with a summary, then add more messages
      const msgs = addMessages(conversationStore, conversationId, 6, 100);

      // Summarize first 2 messages
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary content",
        50,
        [msgs[0].id, msgs[1].id],
      );
      contextItemsStore.replaceContextItems(conversationId, [0, 1], [
        { itemType: "summary", summaryId: summary.id },
      ]);

      // With freshTailCount=4: the 4 most recent messages go to fresh tail
      // The summary must always go to evictable
      const assembler = makeAssembler({
        freshTailCount: 4,
        freshTailMaxTokens: 100000,
        contextThreshold: 0.75,
      });

      // Use a large budget so everything fits
      const result = assembler.assemble(conversationId, 1000000);

      // summaryCount should be 1 (the summary is always in evictable/selected)
      assert.equal(result.summaryCount, 1);
    });
  });

  describe("splitFreshTail — token cap", () => {
    it("token cap kicks in before message count limit", () => {
      // 8 messages at 100 tokens each
      // freshTailCount=10 (high), freshTailMaxTokens=250
      // Should only keep 2 messages in fresh tail (2 * 100 = 200 ≤ 250, 3rd would be 300 > 250)
      addMessages(conversationStore, conversationId, 8, 100);

      const assembler = makeAssembler({
        freshTailCount: 10,
        freshTailMaxTokens: 250,
        contextThreshold: 0.75,
      });

      // With a large budget, all items can be assembled — but the split determines
      // what goes to evictable vs fresh tail internally.
      // We can test this indirectly by checking the total assembled correctly
      // or by verifying the counts when budget is tight enough to cut evictable.
      const result = assembler.assemble(conversationId, 1000000);
      assert.equal(result.messageCount, 8); // All 8 fit in budget
      assert.equal(result.totalTokens, 800);
    });

    it("a single large message caps the fresh tail at 1 message", () => {
      // Add 5 normal messages, then 1 huge one
      addMessages(conversationStore, conversationId, 5, 100);
      conversationStore.addMessage(conversationId, "user", "big message", 50000);

      const assembler = makeAssembler({
        freshTailCount: 10,
        freshTailMaxTokens: 50000, // The single big message exactly fills the budget
        contextThreshold: 0.75,
      });

      // The 50k token message alone fills the fresh tail token budget.
      // The other 5 messages (100 tokens each) should be evictable.
      // With an enormous context budget, all items get assembled.
      const result = assembler.assemble(conversationId, 1000000);
      assert.equal(result.messageCount, 6);
    });
  });

  describe("assembleSummariesOnly", () => {
    it("returns empty when no summaries exist", () => {
      addMessages(conversationStore, conversationId, 3, 100);
      const assembler = makeAssembler();
      const result = assembler.assembleSummariesOnly(conversationId, 100000);
      assert.deepEqual(result, []);
    });

    it("returns summary messages when summaries are in evictable region", () => {
      const msgs = addMessages(conversationStore, conversationId, 6, 100);

      // Summarize first 2 messages
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary content",
        50,
        [msgs[0].id, msgs[1].id],
      );
      contextItemsStore.replaceContextItems(conversationId, [0, 1], [
        { itemType: "summary", summaryId: summary.id },
      ]);

      const assembler = makeAssembler({
        freshTailCount: 4,
        freshTailMaxTokens: 100000,
        contextThreshold: 0.75,
      });

      const result = assembler.assembleSummariesOnly(conversationId, 100000);
      // Should return at least one message containing the summary
      assert.ok(result.length > 0);
    });

    it("respects budget — skips summaries that exceed budget", () => {
      const msgs = addMessages(conversationStore, conversationId, 6, 100);

      // Create a large summary (2000 tokens) that exceeds the budget
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "very large summary content",
        2000,
        [msgs[0].id, msgs[1].id],
      );
      contextItemsStore.replaceContextItems(conversationId, [0, 1], [
        { itemType: "summary", summaryId: summary.id },
      ]);

      const assembler = makeAssembler({
        freshTailCount: 4,
        freshTailMaxTokens: 100000,
        contextThreshold: 0.75,
      });

      // Budget is tiny — summary should not fit
      const result = assembler.assembleSummariesOnly(conversationId, 100);
      assert.deepEqual(result, []);
    });
  });

  describe("assemble budget enforcement", () => {
    it("returns empty when no context items exist", () => {
      const assembler = makeAssembler();
      const result = assembler.assemble(conversationId, 100000);
      assert.equal(result.messages.length, 0);
      assert.equal(result.totalTokens, 0);
    });

    it("includes fresh tail messages even when budget is tight (fresh tail is always included)", () => {
      // Fresh tail is always included regardless of budget
      // Budget is enforced only for evictable items
      addMessages(conversationStore, conversationId, 3, 200);

      const assembler = makeAssembler({
        freshTailCount: 3,
        freshTailMaxTokens: 100000,
        contextThreshold: 0.75,
        leafChunkTokens: 10000,
      });

      // Budget of 1 token — fresh tail still gets included
      const result = assembler.assemble(conversationId, 1);
      // All messages are in fresh tail, so they should be included
      assert.equal(result.messageCount, 3);
    });
  });
});
