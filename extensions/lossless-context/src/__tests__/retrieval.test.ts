import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { RetrievalEngine } from "../retrieval.js";
import { createStores, setupTestDb } from "./helpers.js";

describe("RetrievalEngine leaf expansion", () => {
  it("renders decoded canonical detail with local and session provenance", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore, summaryStore } = createStores(
      drizzleDb,
      db,
      hasFts5,
    );
    const conversation = conversationStore.getOrCreateConversation("expand");
    const canonical: AgentMessage = {
      role: "custom",
      customType: "expand-fixture",
      content: "readable detail",
      display: true,
      details: { preserved: "exact metadata" },
      timestamp: 1,
    };
    const row = conversationStore.addMessage({
      conversationId: conversation.id,
      sessionEntryId: "expand-entry",
      sessionParentEntryId: "expand-parent",
      sessionEntryType: "custom_message",
      message: canonical,
    }).message;
    const summary = summaryStore.createLeafSummary(
      conversation.id,
      "leaf",
      1,
      [row.id],
    );

    const result = new RetrievalEngine(
      conversationStore,
      summaryStore,
    ).expand(summary.id, 1000);
    assert.ok(result);
    const item = result.items[0];
    assert.equal(item?.type, "message");
    if (item?.type === "message") {
      assert.equal(item.id, row.id);
      assert.equal(item.canonical, true);
      assert.equal(item.sessionEntryId, "expand-entry");
      assert.equal(item.sessionParentEntryId, "expand-parent");
      assert.match(item.content, /Canonical Pi AgentMessage/);
      assert.match(item.content, /exact metadata/);
    }
  });

  it("labels legacy rows as projections rather than exact originals", () => {
    const { db, drizzleDb, hasFts5 } = setupTestDb();
    const { conversationStore, summaryStore } = createStores(
      drizzleDb,
      db,
      hasFts5,
    );
    const conversation = conversationStore.getOrCreateConversation("legacy-expand");
    db.prepare(
      `INSERT INTO messages(
        id, conversation_id, seq, role, canonical_json, search_text,
        token_count, identity_hash, created_at
      ) VALUES (?, ?, 1, 'assistant', NULL, ?, 3, 'legacy-hash', ?)`,
    ).run(
      "legacy-local-id",
      conversation.id,
      "only the old projection survives",
      "2025-01-01T00:00:00.000Z",
    );
    const summary = summaryStore.createLeafSummary(
      conversation.id,
      "legacy leaf",
      1,
      ["legacy-local-id"],
    );

    const result = new RetrievalEngine(
      conversationStore,
      summaryStore,
    ).expand(summary.id, 1000);
    assert.ok(result);
    const item = result.items[0];
    assert.equal(item?.type, "message");
    if (item?.type === "message") {
      assert.equal(item.id, "legacy-local-id");
      assert.equal(item.role, "assistant");
      assert.equal(item.canonical, false);
      assert.match(item.content, /Legacy projection \(not an exact original/);
      assert.match(item.content, /only the old projection survives/);
    }
  });
});
