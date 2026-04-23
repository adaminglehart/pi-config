/**
 * Context items store for LCM.
 * Manages the ordered list of context items (messages and summaries) for each conversation.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { eq, asc, sql, inArray } from "drizzle-orm";
import type { DrizzleDB } from "../db/connection.js";
import { contextItems } from "../db/schema.js";
import type { ContextItemRecord } from "../types.js";

export class ContextItemsStore {
  constructor(
    private drizzle: DrizzleDB,
    private rawDb: DatabaseSync,
  ) {}

  /**
   * Get all context items for a conversation, ordered by ordinal.
   */
  getContextItems(conversationId: string): ContextItemRecord[] {
    return this.drizzle
      .select()
      .from(contextItems)
      .where(eq(contextItems.conversation_id, conversationId))
      .orderBy(asc(contextItems.ordinal))
      .all() as unknown as ContextItemRecord[];
  }

  /**
   * Get next ordinal for a conversation.
   */
  getNextOrdinal(conversationId: string): number {
    const row = this.drizzle
      .select({ max_ordinal: sql<number>`COALESCE(MAX(${contextItems.ordinal}), -1)` })
      .from(contextItems)
      .where(eq(contextItems.conversation_id, conversationId))
      .get();

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

    this.drizzle
      .insert(contextItems)
      .values({
        id,
        conversation_id: conversationId,
        ordinal,
        item_type: itemType,
        message_id: messageId ?? null,
        summary_id: summaryId ?? null,
      })
      .run();

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

    this.drizzle
      .delete(contextItems)
      .where(
        sql`${contextItems.conversation_id} = ${conversationId} AND ${contextItems.ordinal} IN (${sql.join(ordinals.map((o) => sql`${o}`), sql`, `)})`,
      )
      .run();
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
    this.rawDb.exec("BEGIN");

    try {
      // Remove old items
      if (removeOrdinals.length > 0) {
        this.removeContextItems(conversationId, removeOrdinals);
      }

      const insertAt = removeOrdinals.length > 0
        ? Math.min(...removeOrdinals)
        : this.getNextOrdinal(conversationId);

      const remaining = this.drizzle
        .select({
          id: contextItems.id,
          item_type: contextItems.item_type,
          message_id: contextItems.message_id,
          summary_id: contextItems.summary_id,
        })
        .from(contextItems)
        .where(eq(contextItems.conversation_id, conversationId))
        .orderBy(asc(contextItems.ordinal))
        .all() as Array<{
          id: string;
          item_type: string;
          message_id: string | null;
          summary_id: string | null;
        }>;

      const before = remaining.slice(0, insertAt);
      const after = remaining.slice(insertAt);

      // Delete all remaining items and re-insert in correct order
      this.drizzle
        .delete(contextItems)
        .where(eq(contextItems.conversation_id, conversationId))
        .run();

      let ordinal = 0;
      for (const item of before) {
        this.drizzle
          .insert(contextItems)
          .values({
            id: item.id,
            conversation_id: conversationId,
            ordinal: ordinal++,
            item_type: item.item_type as "message" | "summary",
            message_id: item.message_id,
            summary_id: item.summary_id,
          })
          .run();
      }
      for (const item of newItems) {
        this.drizzle
          .insert(contextItems)
          .values({
            id: randomUUID(),
            conversation_id: conversationId,
            ordinal: ordinal++,
            item_type: item.itemType,
            message_id: item.messageId ?? null,
            summary_id: item.summaryId ?? null,
          })
          .run();
      }
      for (const item of after) {
        this.drizzle
          .insert(contextItems)
          .values({
            id: item.id,
            conversation_id: conversationId,
            ordinal: ordinal++,
            item_type: item.item_type as "message" | "summary",
            message_id: item.message_id,
            summary_id: item.summary_id,
          })
          .run();
      }

      this.rawDb.exec("COMMIT");
    } catch (error) {
      this.rawDb.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Rebuild context items from all messages in a conversation.
   * Removes all existing context items and re-creates them from the message table.
   * Used by recompact to start from a clean state.
   */
  rebuildFromMessages(conversationId: string): void {
    try {
      this.rawDb.exec("BEGIN IMMEDIATE");

      this.drizzle
        .delete(contextItems)
        .where(eq(contextItems.conversation_id, conversationId))
        .run();

      // Use raw SQL for lower(hex(randomblob(16))) UUID generation
      this.rawDb
        .prepare(
          `INSERT INTO context_items (id, conversation_id, ordinal, item_type, message_id)
           SELECT lower(hex(randomblob(16))), conversation_id, seq - 1, 'message', id
           FROM messages
           WHERE conversation_id = ?
           ORDER BY seq`,
        )
        .run(conversationId);

      this.rawDb.exec("COMMIT");
    } catch (error) {
      this.rawDb.exec("ROLLBACK");
      throw error;
    }
  }
}
