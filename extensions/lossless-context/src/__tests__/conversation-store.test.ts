import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeStoredMessage } from "../message-codec.js";
import { ConversationStore } from "../store/conversation-store.js";
import { createStores, makeUserMessage, setupTestDb } from "./helpers.js";

function toolCallMessage(timestamp = 2): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tool-call-1",
        name: "read",
        arguments: { path: "/tmp/example" },
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "UNSEARCHABLE_MODEL_METADATA",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  };
}

describe("ConversationStore canonical persistence", () => {
  it("preserves canonical payload and keeps projection separate", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("canonical");
    const original = toolCallMessage();

    const result = conversationStore.addMessage({
      conversationId: conversation.id,
      sessionEntryId: "entry-1",
      sessionParentEntryId: "parent-1",
      sessionEntryType: "message",
      message: original,
    });

    assert.equal(result.status, "inserted");
    assert.equal(result.message.session_entry_id, "entry-1");
    assert.equal(result.message.session_parent_entry_id, "parent-1");
    assert.equal(result.message.session_entry_type, "message");
    assert.equal(result.message.identity_hash, null);
    assert.match(result.message.search_text, /read|tool-call-1/);
    assert.doesNotMatch(result.message.search_text, /UNSEARCHABLE_MODEL_METADATA/);
    assert.deepEqual(decodeStoredMessage(result.message).message, original);
  });

  it("uses stable entry identity for replay without duplicate side effects", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore, contextItemsStore } = createStores(
      drizzleDb,
      db,
      hasFts5,
    );
    const conversation = conversationStore.getOrCreateConversation("replay");
    const request = {
      conversationId: conversation.id,
      sessionEntryId: "same-entry",
      sessionParentEntryId: null,
      sessionEntryType: "message" as const,
      message: makeUserMessage("same searchable message"),
    };

    const first = conversationStore.addMessage(request);
    const replay = conversationStore.addMessage(request);
    assert.equal(first.status, "inserted");
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.message.id, first.message.id);
    assert.equal(conversationStore.getMessageCount(conversation.id), 1);
    assert.equal(contextItemsStore.getContextItems(conversation.id).length, 1);
    assert.equal(
      conversationStore.searchMessages("searchable", conversation.id).length,
      1,
    );
  });

  it("keeps equal content distinct for different entry IDs and orders local seq", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("equal");
    const common = {
      conversationId: conversation.id,
      sessionParentEntryId: null,
      sessionEntryType: "message" as const,
      message: makeUserMessage("identical"),
    };

    const first = conversationStore.addMessage({
      ...common,
      sessionEntryId: "equal-1",
    });
    const second = conversationStore.addMessage({
      ...common,
      sessionEntryId: "equal-2",
    });
    assert.equal(first.status, "inserted");
    assert.equal(second.status, "inserted");
    assert.notEqual(first.message.id, second.message.id);
    assert.deepEqual(
      conversationStore.getMessages(conversation.id).map((row) => row.seq),
      [1, 2],
    );
  });

  it("scopes entry identity to a conversation", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const firstConversation = conversationStore.getOrCreateConversation("one");
    const secondConversation = conversationStore.getOrCreateConversation("two");

    for (const conversationId of [firstConversation.id, secondConversation.id]) {
      const result = conversationStore.addMessage({
        conversationId,
        sessionEntryId: "shared-entry-id",
        sessionParentEntryId: null,
        sessionEntryType: "message",
        message: makeUserMessage("shared"),
      });
      assert.equal(result.status, "inserted");
    }
  });

  it("persists assistant tool-only messages and searches only projection text", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const conversationStore = new ConversationStore(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("search");
    conversationStore.addMessage({
      conversationId: conversation.id,
      sessionEntryId: "tool-only",
      sessionParentEntryId: null,
      sessionEntryType: "message",
      message: toolCallMessage(),
    });

    assert.equal(conversationStore.getMessageCount(conversation.id), 1);
    assert.equal(conversationStore.searchMessages("read", conversation.id).length, 1);
    assert.equal(
      conversationStore.searchMessages(
        "UNSEARCHABLE_MODEL_METADATA",
        conversation.id,
      ).length,
      0,
    );

    const likeStore = new ConversationStore(drizzleDb, db, false);
    assert.equal(likeStore.searchMessages("tool-call-1", conversation.id).length, 1);
    assert.equal(
      likeStore.searchMessages("UNSEARCHABLE_MODEL_METADATA", conversation.id)
        .length,
      0,
    );
  });

  it("falls back to LIKE when FTS indexing or querying fails", () => {
    const { db, drizzleDb } = setupTestDb();
    db.exec("DROP TABLE IF EXISTS messages_fts");

    const conversationStore = new ConversationStore(drizzleDb, db, true);
    const conversation = conversationStore.getOrCreateConversation("fts-failure");
    conversationStore.addMessage({
      conversationId: conversation.id,
      sessionEntryId: "fts-failure-entry",
      sessionParentEntryId: null,
      sessionEntryType: "message",
      message: makeUserMessage("fallback remains searchable"),
    });

    assert.equal(
      conversationStore.searchMessages("searchable", conversation.id).length,
      1,
    );

    const freshStore = new ConversationStore(drizzleDb, db, true);
    assert.equal(freshStore.searchMessages("fallback", conversation.id).length, 1);
  });
});
