/**
 * Tests for ContextItemsStore and SummaryStore.
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { setupTestDb, createStores, addMessages } from "./helpers.js";

describe("ContextItemsStore", () => {
  let db: DatabaseSync;
  let drizzleDb: import("../db/connection.js").DrizzleDB;
  let hasFts5: boolean;
  let conversationStore: ReturnType<typeof createStores>["conversationStore"];
  let summaryStore: ReturnType<typeof createStores>["summaryStore"];
  let contextItemsStore: ReturnType<typeof createStores>["contextItemsStore"];
  let conversationId: string;

  beforeEach(() => {
    ({ db, drizzleDb, hasFts5 } = setupTestDb());
    ({ conversationStore, summaryStore, contextItemsStore } = createStores(drizzleDb, db, hasFts5));
    const convo = conversationStore.getOrCreateConversation("test-session");
    conversationId = convo.id;
  });

  describe("replaceContextItems", () => {
    it("places new items at MIN(removed ordinals) and renumbers sequentially", () => {
      // Add 5 messages → context_items ordinals 0..4
      const msgs = addMessages(conversationStore, conversationId, 5, 100);

      // Replace ordinals 1, 2, 3 with a summary
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary of 1-3",
        50,
        [msgs[1].id, msgs[2].id, msgs[3].id],
      );

      contextItemsStore.replaceContextItems(
        conversationId,
        [1, 2, 3],
        [{ itemType: "summary", summaryId: summary.id }],
      );

      const items = contextItemsStore.getContextItems(conversationId);
      // Should have 3 items: msg0, summary, msg4
      assert.equal(items.length, 3);
      assert.equal(items[0].ordinal, 0);
      assert.equal(items[0].item_type, "message");
      assert.equal(items[0].message_id, msgs[0].id);

      assert.equal(items[1].ordinal, 1);
      assert.equal(items[1].item_type, "summary");
      assert.equal(items[1].summary_id, summary.id);

      assert.equal(items[2].ordinal, 2);
      assert.equal(items[2].item_type, "message");
      assert.equal(items[2].message_id, msgs[4].id);
    });

    it("positions replacement at the start when first items are removed", () => {
      const msgs = addMessages(conversationStore, conversationId, 4, 100);

      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary of first 2",
        50,
        [msgs[0].id, msgs[1].id],
      );

      contextItemsStore.replaceContextItems(
        conversationId,
        [0, 1],
        [{ itemType: "summary", summaryId: summary.id }],
      );

      const items = contextItemsStore.getContextItems(conversationId);
      assert.equal(items.length, 3);
      assert.equal(items[0].ordinal, 0);
      assert.equal(items[0].item_type, "summary");
      assert.equal(items[1].ordinal, 1);
      assert.equal(items[1].message_id, msgs[2].id);
      assert.equal(items[2].ordinal, 2);
      assert.equal(items[2].message_id, msgs[3].id);
    });

    it("handles replacing at the end", () => {
      const msgs = addMessages(conversationStore, conversationId, 4, 100);

      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary of last 2",
        50,
        [msgs[2].id, msgs[3].id],
      );

      contextItemsStore.replaceContextItems(
        conversationId,
        [2, 3],
        [{ itemType: "summary", summaryId: summary.id }],
      );

      const items = contextItemsStore.getContextItems(conversationId);
      assert.equal(items.length, 3);
      assert.equal(items[0].ordinal, 0);
      assert.equal(items[0].message_id, msgs[0].id);
      assert.equal(items[1].ordinal, 1);
      assert.equal(items[1].message_id, msgs[1].id);
      assert.equal(items[2].ordinal, 2);
      assert.equal(items[2].item_type, "summary");
    });

    it("produces gap-free ordinals after replacement", () => {
      const msgs = addMessages(conversationStore, conversationId, 6, 100);

      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary",
        50,
        [msgs[1].id, msgs[2].id, msgs[3].id],
      );

      contextItemsStore.replaceContextItems(
        conversationId,
        [1, 2, 3],
        [{ itemType: "summary", summaryId: summary.id }],
      );

      const items = contextItemsStore.getContextItems(conversationId);
      // Ordinals must be 0, 1, 2, 3 (no gaps)
      for (let i = 0; i < items.length; i++) {
        assert.equal(items[i].ordinal, i);
      }
    });
  });

  describe("rebuildFromMessages", () => {
    it("creates sequential ordinals matching message seq", () => {
      const msgs = addMessages(conversationStore, conversationId, 5, 100);

      // Mess up context items by manually doing some replacements
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "summary",
        50,
        [msgs[0].id, msgs[1].id],
      );
      contextItemsStore.replaceContextItems(conversationId, [0, 1], [
        { itemType: "summary", summaryId: summary.id },
      ]);

      // Rebuild from messages
      contextItemsStore.rebuildFromMessages(conversationId);

      const items = contextItemsStore.getContextItems(conversationId);
      // Should have exactly 5 message items with ordinals 0..4
      assert.equal(items.length, 5);
      for (let i = 0; i < items.length; i++) {
        assert.equal(items[i].ordinal, i);
        assert.equal(items[i].item_type, "message");
        assert.equal(items[i].message_id, msgs[i].id);
      }
    });

    it("clears existing items and replaces with message-based items", () => {
      addMessages(conversationStore, conversationId, 3, 100);

      // Rebuild
      contextItemsStore.rebuildFromMessages(conversationId);
      const items = contextItemsStore.getContextItems(conversationId);

      // All items should be message type
      for (const item of items) {
        assert.equal(item.item_type, "message");
        assert.ok((item.message_id) !== null);
      }
    });
  });
});

describe("SummaryStore", () => {
  let db: DatabaseSync;
  let drizzleDb: import("../db/connection.js").DrizzleDB;
  let hasFts5: boolean;
  let conversationStore: ReturnType<typeof createStores>["conversationStore"];
  let summaryStore: ReturnType<typeof createStores>["summaryStore"];
  let contextItemsStore: ReturnType<typeof createStores>["contextItemsStore"];
  let conversationId: string;

  beforeEach(() => {
    ({ db, drizzleDb, hasFts5 } = setupTestDb());
    ({ conversationStore, summaryStore, contextItemsStore } = createStores(drizzleDb, db, hasFts5));
    const convo = conversationStore.getOrCreateConversation("test-session");
    conversationId = convo.id;
  });

  describe("isMessageSummarized", () => {
    it("returns false when message has no summary", () => {
      const msg = conversationStore.addMessage(conversationId, "user", "hi", 10);
      assert.equal(summaryStore.isMessageSummarized(msg.id), false);
    });

    it("returns true after message is covered by a leaf summary", () => {
      const msg = conversationStore.addMessage(conversationId, "user", "hi", 10);
      summaryStore.createLeafSummary(conversationId, "summary", 5, [msg.id]);
      assert.equal(summaryStore.isMessageSummarized(msg.id), true);
    });

    it("returns false for a different message not in any summary", () => {
      const msg1 = conversationStore.addMessage(conversationId, "user", "hi", 10);
      const msg2 = conversationStore.addMessage(conversationId, "assistant", "hello", 10);
      summaryStore.createLeafSummary(conversationId, "summary", 5, [msg1.id]);
      assert.equal(summaryStore.isMessageSummarized(msg2.id), false);
    });
  });

  describe("createLeafSummary", () => {
    it("creates a summary with depth 0 and kind leaf", () => {
      const msgs = addMessages(conversationStore, conversationId, 3, 100);
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "leaf summary content",
        50,
        msgs.map((m) => m.id),
      );

      assert.equal(summary.kind, "leaf");
      assert.equal(summary.depth, 0);
      assert.equal(summary.content, "leaf summary content");
      assert.equal(summary.token_count, 50);

      // Verify it's retrievable
      const fetched = summaryStore.getSummary(summary.id);
      assert.ok(fetched !== undefined);
      assert.equal(fetched!.id, summary.id);
    });

    it("links source messages via summary_messages", () => {
      const msgs = addMessages(conversationStore, conversationId, 3, 100);
      const summary = summaryStore.createLeafSummary(
        conversationId,
        "content",
        50,
        msgs.map((m) => m.id),
      );

      const linkedIds = summaryStore.getSummaryMessageIds(summary.id);
      assert.deepEqual(linkedIds.sort(), msgs.map((m) => m.id).sort());
    });
  });

  describe("createCondensedSummary", () => {
    it("creates a condensed summary with the given depth and links parents", () => {
      const msgs1 = addMessages(conversationStore, conversationId, 3, 100);
      const msgs2 = addMessages(conversationStore, conversationId, 3, 100);

      const leaf1 = summaryStore.createLeafSummary(
        conversationId,
        "leaf1",
        50,
        msgs1.map((m) => m.id),
      );
      const leaf2 = summaryStore.createLeafSummary(
        conversationId,
        "leaf2",
        50,
        msgs2.map((m) => m.id),
      );

      const condensed = summaryStore.createCondensedSummary(
        conversationId,
        "condensed",
        30,
        1,
        [leaf1.id, leaf2.id],
      );

      assert.equal(condensed.kind, "condensed");
      assert.equal(condensed.depth, 1);

      const parentIds = summaryStore.getSummaryParentIds(condensed.id);
      assert.deepEqual(parentIds, []);

      // Leafs should point up to the condensed
      const leaf1Parents = summaryStore.getSummaryParentIds(leaf1.id);
      assert.deepEqual(leaf1Parents, [condensed.id]);
      const leaf2Parents = summaryStore.getSummaryParentIds(leaf2.id);
      assert.deepEqual(leaf2Parents, [condensed.id]);
    });
  });

  describe("clearConversationSummaries", () => {
    it("removes summaries, summary_messages, and summary_parents", () => {
      const msgs = addMessages(conversationStore, conversationId, 4, 100);
      const leaf1 = summaryStore.createLeafSummary(
        conversationId,
        "leaf1",
        50,
        [msgs[0].id, msgs[1].id],
      );
      const leaf2 = summaryStore.createLeafSummary(
        conversationId,
        "leaf2",
        50,
        [msgs[2].id, msgs[3].id],
      );
      summaryStore.createCondensedSummary(
        conversationId,
        "condensed",
        30,
        1,
        [leaf1.id, leaf2.id],
      );

      summaryStore.clearConversationSummaries(conversationId);

      // All summaries gone
      const allSummaries = summaryStore.getAllSummaries(conversationId);
      assert.equal(allSummaries.length, 0);

      // isMessageSummarized should now return false (summary_messages cleared)
      assert.equal(summaryStore.isMessageSummarized(msgs[0].id), false);
      assert.equal(summaryStore.isMessageSummarized(msgs[1].id), false);
    });

    it("does not affect summaries in other conversations", () => {
      const convo2 = conversationStore.getOrCreateConversation("other-session");
      const msgs1 = addMessages(conversationStore, conversationId, 2, 100);
      const msgs2 = addMessages(conversationStore, convo2.id, 2, 100);

      summaryStore.createLeafSummary(conversationId, "s1", 50, msgs1.map((m) => m.id));
      summaryStore.createLeafSummary(convo2.id, "s2", 50, msgs2.map((m) => m.id));

      summaryStore.clearConversationSummaries(conversationId);

      const remaining = summaryStore.getAllSummaries(convo2.id);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].content, "s2");
    });
  });
});
