import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeStoredMessage } from "../message-codec.js";
import { SessionMessageSynchronizer } from "../session-message-synchronizer.js";
import { createStores, makeUserMessage, setupTestDb } from "./helpers.js";

function fakeManager(
  entries: SessionEntry[],
): ExtensionContext["sessionManager"] {
  return { getEntries: () => entries } as ExtensionContext["sessionManager"];
}

function messageEntry(
  id: string,
  message: AgentMessage,
  parentId: string | null = null,
): Extract<SessionEntry, { type: "message" }> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

describe("SessionMessageSynchronizer", () => {
  it("seeds baseline entries without importing them", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("baseline");
    const entries: SessionEntry[] = [
      messageEntry("existing", makeUserMessage("historical")),
    ];
    const synchronizer = new SessionMessageSynchronizer(
      conversationStore,
      conversation.id,
      entries,
    );

    const result = synchronizer.syncNewEntries(fakeManager(entries));
    assert.equal(result.inserted, 0);
    assert.equal(result.pendingEntries, 0);
    assert.equal(result.safeForContextReplacement, true);
    assert.equal(conversationStore.getMessageCount(conversation.id), 0);
  });

  it("reports pending message_end work until Pi appends its final entry", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("pending");
    const entries: SessionEntry[] = [];
    const manager = fakeManager(entries);
    const synchronizer = new SessionMessageSynchronizer(
      conversationStore,
      conversation.id,
      entries,
    );

    const finalMessage = makeUserMessage("final payload", 100);
    synchronizer.noteFinalizedMessage(makeUserMessage("early payload", 99));
    const pending = synchronizer.syncNewEntries(manager);
    assert.equal(pending.pendingFinalizedMessages, 1);
    assert.equal(pending.safeForContextReplacement, false);

    entries.push(messageEntry("entry-final", finalMessage, "parent-final"));
    const flushed = synchronizer.syncNewEntries(manager);
    assert.equal(flushed.inserted, 1);
    assert.equal(flushed.pendingFinalizedMessages, 0);
    assert.equal(flushed.safeForContextReplacement, true);

    const row = conversationStore.getMessageBySessionEntryId(
      conversation.id,
      "entry-final",
    );
    assert.ok(row);
    assert.equal(row.session_parent_entry_id, "parent-final");
    assert.deepEqual(decodeStoredMessage(row).message, finalMessage);
  });

  it("persists identical appended messages separately and in append order", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("order");
    const entries: SessionEntry[] = [];
    const synchronizer = new SessionMessageSynchronizer(
      conversationStore,
      conversation.id,
      entries,
    );
    entries.push(
      messageEntry("entry-a", makeUserMessage("same", 1)),
      messageEntry("entry-b", makeUserMessage("same", 2), "entry-a"),
    );

    const first = synchronizer.syncNewEntries(fakeManager(entries));
    const replay = synchronizer.syncNewEntries(fakeManager(entries));
    assert.equal(first.inserted, 2);
    assert.equal(replay.inserted, 0);
    assert.deepEqual(
      conversationStore.getMessages(conversation.id).map((row) => ({
        entry: row.session_entry_id,
        seq: row.seq,
      })),
      [
        { entry: "entry-a", seq: 1 },
        { entry: "entry-b", seq: 2 },
      ],
    );
  });

  it("converts custom_message entries through Pi's public projection", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("custom");
    const entries: SessionEntry[] = [];
    const synchronizer = new SessionMessageSynchronizer(
      conversationStore,
      conversation.id,
      entries,
    );
    entries.push({
      type: "custom_message",
      id: "custom-entry",
      parentId: null,
      timestamp: "2025-01-01T00:00:00.000Z",
      customType: "fixture",
      content: [{ type: "text", text: "custom authoritative text" }],
      details: { exact: true },
      display: true,
    });

    const result = synchronizer.syncNewEntries(fakeManager(entries));
    assert.equal(result.inserted, 1);
    const row = conversationStore.getMessageBySessionEntryId(
      conversation.id,
      "custom-entry",
    );
    assert.ok(row);
    assert.equal(row.session_entry_type, "custom_message");
    assert.deepEqual(decodeStoredMessage(row).message, {
      role: "custom",
      customType: "fixture",
      content: [{ type: "text", text: "custom authoritative text" }],
      display: true,
      details: { exact: true },
      timestamp: Date.parse("2025-01-01T00:00:00.000Z"),
    });
  });

  it("leaves failed entries and their later append-order work retryable", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("retry");
    const entries: SessionEntry[] = [];
    const synchronizer = new SessionMessageSynchronizer(
      conversationStore,
      conversation.id,
      entries,
    );
    entries.push(
      messageEntry("retry-first", makeUserMessage("first")),
      messageEntry("retry-second", makeUserMessage("second"), "retry-first"),
    );

    const originalAddMessage = conversationStore.addMessage.bind(conversationStore);
    let failOnce = true;
    conversationStore.addMessage = (request) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("fixture failure");
      }
      return originalAddMessage(request);
    };

    const failed = synchronizer.syncNewEntries(fakeManager(entries));
    assert.equal(failed.failed, 1);
    assert.equal(failed.pendingEntries, 2);
    assert.equal(failed.safeForContextReplacement, false);
    assert.equal(conversationStore.getMessageCount(conversation.id), 0);

    const retried = synchronizer.syncNewEntries(fakeManager(entries));
    assert.equal(retried.inserted, 2);
    assert.equal(retried.pendingEntries, 0);
    assert.equal(retried.safeForContextReplacement, true);
    assert.deepEqual(
      conversationStore.getMessages(conversation.id).map((row) => row.session_entry_id),
      ["retry-first", "retry-second"],
    );
  });

  it("marks unsupported entries seen and reports normal duplicate inserts", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore } = createStores(drizzleDb, db, hasFts5);
    const conversation = conversationStore.getOrCreateConversation("skip");
    conversationStore.addMessage({
      conversationId: conversation.id,
      sessionEntryId: "already-stored",
      sessionParentEntryId: null,
      sessionEntryType: "message",
      message: makeUserMessage("stored"),
    });
    const entries: SessionEntry[] = [];
    const synchronizer = new SessionMessageSynchronizer(
      conversationStore,
      conversation.id,
      entries,
    );
    entries.push(
      {
        type: "model_change",
        id: "unsupported",
        parentId: null,
        timestamp: "2025-01-01T00:00:00.000Z",
        provider: "anthropic",
        modelId: "model",
      },
      messageEntry("already-stored", makeUserMessage("stored")),
    );
    synchronizer.noteFinalizedMessage(makeUserMessage("stored"));

    const first = synchronizer.syncNewEntries(fakeManager(entries));
    const replay = synchronizer.syncNewEntries(fakeManager(entries));
    assert.equal(first.skipped, 1);
    assert.equal(first.duplicates, 1);
    assert.equal(first.pendingFinalizedMessages, 0);
    assert.equal(replay.skipped, 0);
    assert.equal(replay.duplicates, 0);
  });
});
