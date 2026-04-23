/**
 * Context items store for LCM.
 * Manages the ordered list of context items (messages and summaries) for each conversation.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContextItemRecord } from "../types.js";

export class ContextItemsStore {
  constructor(private db: DatabaseSync) {}

  /**
   * Get all context items for a conversation, ordered by ordinal.
   */
  getContextItems(conversationId: string): ContextItemRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, conversation_id, ordinal, item_type, message_id, summary_id
        FROM context_items
        WHERE conversation_id = ?
        ORDER BY ordinal ASC
      `,
      )
      .all(conversationId);

    return rows as unknown as ContextItemRecord[];
  }

  /**
   * Get next ordinal for a conversation.
   */
  getNextOrdinal(conversationId: string): number {
    const row = this.db
      .prepare(
        `
        SELECT COALESCE(MAX(ordinal), -1) as max_ordinal
        FROM context_items
        WHERE conversation_id = ?
      `,
      )
      .get(conversationId) as { max_ordinal: number } | undefined;

    return (row?.max_ordinal ?? -1) + 1;
  }

  /**
   * Add a context item (message or summary).
   */
  addContextItem(
    conversationId: string,
    itemType: "message" | "summary",
    messageId?: string,
    summaryId?: string,
  ): ContextItemRecord {
    const id = randomUUID();
    const ordinal = this.getNextOrdinal(conversationId);

    this.db
      .prepare(
        `
        INSERT INTO context_items (id, conversation_id, ordinal, item_type, message_id, summary_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        conversationId,
        ordinal,
        itemType,
        messageId ?? null,
        summaryId ?? null,
      );

    return {
      id,
      conversation_id: conversationId,
      ordinal,
      item_type: itemType,
      message_id: messageId ?? null,
      summary_id: summaryId ?? null,
    };
  }

  /**
   * Remove context items by ordinal.
   */
  removeContextItems(conversationId: string, ordinals: number[]): void {
    if (ordinals.length === 0) return;

    // Build placeholders for IN clause
    const placeholders = ordinals.map(() => "?").join(",");

    this.db
      .prepare(
        `
        DELETE FROM context_items
        WHERE conversation_id = ? AND ordinal IN (${placeholders})
      `,
      )
      .run(conversationId, ...ordinals);
  }

  /**
   * Atomically replace context items: remove old ordinals and insert new items
   * at the position of the first removed ordinal (preserving chronological order).
   * Renumbers all remaining items to keep ordinals dense and gap-free.
   * Used during compaction to swap raw messages for summaries.
   */
  replaceContextItems(
    conversationId: string,
    removeOrdinals: number[],
    newItems: Array<{
      itemType: "message" | "summary";
      messageId?: string;
      summaryId?: string;
    }>,
  ): void {
    this.db.exec("BEGIN");

    try {
      // Remove old items
      if (removeOrdinals.length > 0) {
        this.removeContextItems(conversationId, removeOrdinals);
      }

      // Fetch remaining items in order and renumber from 0,
      // inserting new items at the position where the removed block started.
      const insertAt = removeOrdinals.length > 0
        ? Math.min(...removeOrdinals)
        : this.getNextOrdinal(conversationId);

      const remaining = this.db
        .prepare(
          `SELECT id, item_type, message_id, summary_id
           FROM context_items
           WHERE conversation_id = ?
           ORDER BY ordinal ASC`,
        )
        .all(conversationId) as Array<{
          id: string;
          item_type: string;
          message_id: string | null;
          summary_id: string | null;
        }>;

      // Build the new ordered list: items before insertAt, then newItems, then items from insertAt onward
      // Since we already deleted the removed ordinals, "before insertAt" means the first `insertAt` items
      // (ordinals 0..insertAt-1 were below the removed range).
      const before = remaining.slice(0, insertAt);
      const after = remaining.slice(insertAt);

      // Delete all remaining items and re-insert in correct order
      this.db
        .prepare(`DELETE FROM context_items WHERE conversation_id = ?`)
        .run(conversationId);

      const insertStmt = this.db.prepare(
        `INSERT INTO context_items (id, conversation_id, ordinal, item_type, message_id, summary_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      let ordinal = 0;
      for (const item of before) {
        insertStmt.run(item.id, conversationId, ordinal++, item.item_type, item.message_id, item.summary_id);
      }
      for (const item of newItems) {
        insertStmt.run(randomUUID(), conversationId, ordinal++, item.itemType, item.messageId ?? null, item.summaryId ?? null);
      }
      for (const item of after) {
        insertStmt.run(item.id, conversationId, ordinal++, item.item_type, item.message_id, item.summary_id);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
