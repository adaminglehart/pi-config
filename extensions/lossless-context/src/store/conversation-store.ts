/**
 * Message persistence layer for LCM.
 * Handles conversation and message CRUD, FTS5 indexing, and search.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { eq, and, sql, asc, desc, gt, max, count, like } from "drizzle-orm";
import type { DrizzleDB } from "../db/connection.js";
import { conversations, messages, contextItems } from "../db/schema.js";
import type {
  ConversationRecord,
  MessageRecord,
} from "../types.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";

export class ConversationStore {
  constructor(
    private drizzle: DrizzleDB,
    private rawDb: DatabaseSync,
    private hasFts5: boolean,
  ) {}

  /**
   * Get or create a conversation for a session key.
   */
  getOrCreateConversation(sessionKey: string): ConversationRecord {
    const existing = this.drizzle
      .select()
      .from(conversations)
      .where(and(eq(conversations.session_key, sessionKey), eq(conversations.active, 1)))
      .limit(1)
      .get() as ConversationRecord | undefined;

    if (existing) {
      return existing;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.drizzle
      .insert(conversations)
      .values({ id, session_key: sessionKey, created_at: now, updated_at: now, active: 1 })
      .run();

    return {
      id,
      session_key: sessionKey,
      created_at: now,
      updated_at: now,
      active: 1,
    };
  }

  /**
   * Get a conversation by ID.
   */
  getConversation(id: string): ConversationRecord | undefined {
    return this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .get() as ConversationRecord | undefined;
  }

  /**
   * Add a message to a conversation.
   * Also creates a context_item and updates FTS5 index if available.
   */
  addMessage(
    conversationId: string,
    role: string,
    content: string,
    tokenCount: number,
    identityHash?: string,
  ): MessageRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Get next seq number
    const lastSeqRow = this.drizzle
      .select({ last_seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .get();

    const seq = (lastSeqRow?.last_seq ?? 0) + 1;

    // Insert message
    this.drizzle
      .insert(messages)
      .values({
        id,
        conversation_id: conversationId,
        seq,
        role,
        content,
        token_count: tokenCount,
        identity_hash: identityHash ?? null,
        created_at: now,
      })
      .run();

    // Add context item
    const contextItemId = randomUUID();
    const nextOrdinal = this.getNextOrdinal(conversationId);

    this.drizzle
      .insert(contextItems)
      .values({
        id: contextItemId,
        conversation_id: conversationId,
        ordinal: nextOrdinal,
        item_type: "message",
        message_id: id,
        summary_id: null,
      })
      .run();

    // Update FTS5 index if available
    if (this.hasFts5) {
      try {
        this.rawDb
          .prepare(
            `INSERT INTO messages_fts (rowid, content) 
             VALUES ((SELECT rowid FROM messages WHERE id = ?), ?)`,
          )
          .run(id, content);
      } catch {
        // FTS5 insert failed - not critical
      }
    }

    return {
      id,
      conversation_id: conversationId,
      seq,
      role,
      content,
      token_count: tokenCount,
      identity_hash: identityHash ?? null,
      created_at: now,
    };
  }

  /**
   * Get a message by ID.
   */
  getMessageById(id: string): MessageRecord | undefined {
    return this.drizzle
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get() as MessageRecord | undefined;
  }

  /**
   * Get messages for a conversation, optionally after a sequence number.
   */
  getMessages(
    conversationId: string,
    afterSeq?: number,
  ): MessageRecord[] {
    if (afterSeq !== undefined) {
      return this.drizzle
        .select()
        .from(messages)
        .where(and(eq(messages.conversation_id, conversationId), gt(messages.seq, afterSeq)))
        .orderBy(asc(messages.seq))
        .all() as unknown as MessageRecord[];
    }

    return this.drizzle
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .orderBy(asc(messages.seq))
      .all() as unknown as MessageRecord[];
  }

  /**
   * Get message count for a conversation.
   */
  getMessageCount(conversationId: string): number {
    const row = this.drizzle
      .select({ count: count() })
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .get();

    return row?.count ?? 0;
  }

  /**
   * Get last sequence number for a conversation.
   */
  getLastSeq(conversationId: string): number {
    const row = this.drizzle
      .select({ last_seq: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .get();

    return row?.last_seq ?? 0;
  }

  /**
   * Search messages using FTS5 or LIKE fallback.
   */
  searchMessages(
    query: string,
    conversationId?: string,
    limit = 20,
  ): Array<{
    id: string;
    conversation_id: string;
    seq: number;
    role: string;
    snippet: string;
    token_count: number;
    created_at: string;
  }> {
    if (this.hasFts5) {
      return this.searchMessagesFts5(query, conversationId, limit);
    } else {
      return this.searchMessagesLike(query, conversationId, limit);
    }
  }

  /**
   * Search using FTS5.
   */
  private searchMessagesFts5(
    query: string,
    conversationId: string | undefined,
    limit: number,
  ): Array<{
    id: string;
    conversation_id: string;
    seq: number;
    role: string;
    snippet: string;
    token_count: number;
    created_at: string;
  }> {
    const sanitized = sanitizeFts5Query(query);

    if (conversationId) {
      const rows = this.rawDb
        .prepare(
          `SELECT 
            m.id,
            m.conversation_id,
            m.seq,
            m.role,
            snippet(messages_fts, 0, '[', ']', '...', 32) as snippet,
            m.token_count,
            m.created_at
          FROM messages_fts
          JOIN messages m ON messages_fts.rowid = m.rowid
          WHERE messages_fts MATCH ? AND m.conversation_id = ?
          ORDER BY rank
          LIMIT ?`,
        )
        .all(sanitized, conversationId, limit);

      return rows as Array<{
        id: string;
        conversation_id: string;
        seq: number;
        role: string;
        snippet: string;
        token_count: number;
        created_at: string;
      }>;
    }

    const rows = this.rawDb
      .prepare(
        `SELECT 
          m.id,
          m.conversation_id,
          m.seq,
          m.role,
          snippet(messages_fts, 0, '[', ']', '...', 32) as snippet,
          m.token_count,
          m.created_at
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      )
      .all(sanitized, limit);

    return rows as Array<{
      id: string;
      conversation_id: string;
      seq: number;
      role: string;
      snippet: string;
      token_count: number;
      created_at: string;
    }>;
  }

  /**
   * Search using LIKE fallback when FTS5 is unavailable.
   */
  private searchMessagesLike(
    query: string,
    conversationId: string | undefined,
    limit: number,
  ): Array<{
    id: string;
    conversation_id: string;
    seq: number;
    role: string;
    snippet: string;
    token_count: number;
    created_at: string;
  }> {
    const likePattern = `%${query}%`;

    let results: Array<{
      id: string;
      conversation_id: string;
      seq: number;
      role: string;
      content: string;
      token_count: number;
      created_at: string;
    }>;

    if (conversationId) {
      results = this.drizzle
        .select({
          id: messages.id,
          conversation_id: messages.conversation_id,
          seq: messages.seq,
          role: messages.role,
          content: messages.content,
          token_count: messages.token_count,
          created_at: messages.created_at,
        })
        .from(messages)
        .where(and(eq(messages.conversation_id, conversationId), like(messages.content, likePattern)))
        .orderBy(desc(messages.created_at))
        .limit(limit)
        .all() as unknown as typeof results;
    } else {
      results = this.drizzle
        .select({
          id: messages.id,
          conversation_id: messages.conversation_id,
          seq: messages.seq,
          role: messages.role,
          content: messages.content,
          token_count: messages.token_count,
          created_at: messages.created_at,
        })
        .from(messages)
        .where(like(messages.content, likePattern))
        .orderBy(desc(messages.created_at))
        .limit(limit)
        .all() as unknown as typeof results;
    }

    return results.map((r) => ({
      ...r,
      snippet: this.createSnippet(r.content, query),
    }));
  }

  /**
   * Create a simple snippet for LIKE search results.
   */
  private createSnippet(content: string, query: string): string {
    const index = content.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) {
      return content.slice(0, 100) + (content.length > 100 ? "..." : "");
    }

    const start = Math.max(0, index - 50);
    const end = Math.min(content.length, index + query.length + 50);
    const snippet = content.slice(start, end);

    return (
      (start > 0 ? "..." : "") +
      snippet +
      (end < content.length ? "..." : "")
    );
  }

  /**
   * Get next ordinal for context items in a conversation.
   */
  private getNextOrdinal(conversationId: string): number {
    const row = this.drizzle
      .select({ max_ordinal: sql<number>`COALESCE(MAX(${contextItems.ordinal}), -1)` })
      .from(contextItems)
      .where(eq(contextItems.conversation_id, conversationId))
      .get();

    return (row?.max_ordinal ?? -1) + 1;
  }
}
