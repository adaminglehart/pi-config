/**
 * Message persistence layer for LCM.
 * Handles conversation and message CRUD, FTS5 indexing, and search.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationRecord,
  MessageRecord,
} from "../types.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";

export class ConversationStore {
  constructor(
    private db: DatabaseSync,
    private hasFts5: boolean,
  ) {}

  /**
   * Get or create a conversation for a session key.
   */
  getOrCreateConversation(sessionKey: string): ConversationRecord {
    // Try to find existing active conversation
    const existing = this.db
      .prepare(
        `
        SELECT id, session_key, created_at, updated_at, active 
        FROM conversations 
        WHERE session_key = ? AND active = 1
        LIMIT 1
      `,
      )
      .get(sessionKey) as ConversationRecord | undefined;

    if (existing) {
      return existing;
    }

    // Create new conversation
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO conversations (id, session_key, created_at, updated_at, active)
        VALUES (?, ?, ?, ?, 1)
      `,
      )
      .run(id, sessionKey, now, now);

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
    return this.db
      .prepare(
        `
        SELECT id, session_key, created_at, updated_at, active 
        FROM conversations 
        WHERE id = ?
      `,
      )
      .get(id) as ConversationRecord | undefined;
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
    const lastSeqRow = this.db
      .prepare(
        `
        SELECT COALESCE(MAX(seq), 0) as last_seq 
        FROM messages 
        WHERE conversation_id = ?
      `,
      )
      .get(conversationId) as { last_seq: number } | undefined;

    const seq = (lastSeqRow?.last_seq ?? 0) + 1;

    // Insert message
    this.db
      .prepare(
        `
        INSERT INTO messages (id, conversation_id, seq, role, content, token_count, identity_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        conversationId,
        seq,
        role,
        content,
        tokenCount,
        identityHash ?? null,
        now,
      );

    // Add context item
    const contextItemId = randomUUID();
    const nextOrdinal = this.getNextOrdinal(conversationId);

    this.db
      .prepare(
        `
        INSERT INTO context_items (id, conversation_id, ordinal, item_type, message_id, summary_id)
        VALUES (?, ?, ?, 'message', ?, NULL)
      `,
      )
      .run(contextItemId, conversationId, nextOrdinal, id);

    // Update FTS5 index if available
    if (this.hasFts5) {
      try {
        this.db
          .prepare(
            `
            INSERT INTO messages_fts (rowid, content) 
            VALUES ((SELECT rowid FROM messages WHERE id = ?), ?)
          `,
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
    return this.db
      .prepare(
        `
        SELECT id, conversation_id, seq, role, content, token_count, identity_hash, created_at 
        FROM messages 
        WHERE id = ?
      `,
      )
      .get(id) as MessageRecord | undefined;
  }

  /**
   * Get messages for a conversation, optionally after a sequence number.
   */
  getMessages(
    conversationId: string,
    afterSeq?: number,
  ): MessageRecord[] {
    let rows;

    if (afterSeq !== undefined) {
      rows = this.db
        .prepare(
          `
          SELECT id, conversation_id, seq, role, content, token_count, identity_hash, created_at 
          FROM messages 
          WHERE conversation_id = ? AND seq > ?
          ORDER BY seq ASC
        `,
        )
        .all(conversationId, afterSeq);
    } else {
      rows = this.db
        .prepare(
          `
          SELECT id, conversation_id, seq, role, content, token_count, identity_hash, created_at 
          FROM messages 
          WHERE conversation_id = ?
          ORDER BY seq ASC
        `,
        )
        .all(conversationId);
    }

    return rows as unknown as MessageRecord[];
  }

  /**
   * Get message count for a conversation.
   */
  getMessageCount(conversationId: string): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) as count 
        FROM messages 
        WHERE conversation_id = ?
      `,
      )
      .get(conversationId) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  /**
   * Get last sequence number for a conversation.
   */
  getLastSeq(conversationId: string): number {
    const row = this.db
      .prepare(
        `
        SELECT COALESCE(MAX(seq), 0) as last_seq 
        FROM messages 
        WHERE conversation_id = ?
      `,
      )
      .get(conversationId) as { last_seq: number } | undefined;

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
      const rows = this.db
        .prepare(
          `
          SELECT 
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
          LIMIT ?
        `,
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

    const rows = this.db
      .prepare(
        `
        SELECT 
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
        LIMIT ?
      `,
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

    if (conversationId) {
      const results = this.db
        .prepare(
          `
          SELECT id, conversation_id, seq, role, content, token_count, created_at
          FROM messages
          WHERE conversation_id = ? AND content LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(conversationId, likePattern, limit) as Array<{
        id: string;
        conversation_id: string;
        seq: number;
        role: string;
        content: string;
        token_count: number;
        created_at: string;
      }>;

      return results.map((r) => ({
        ...r,
        snippet: this.createSnippet(r.content, query),
      }));
    }

    const results = this.db
      .prepare(
        `
        SELECT id, conversation_id, seq, role, content, token_count, created_at
        FROM messages
        WHERE content LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(likePattern, limit) as Array<{
      id: string;
      conversation_id: string;
      seq: number;
      role: string;
      content: string;
      token_count: number;
      created_at: string;
    }>;

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
}
