import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { and, asc, count, desc, eq, gt, like, sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/connection.js";
import { contextItems, conversations, messages } from "../db/schema.js";
import { encodeCanonicalMessage } from "../message-codec.js";
import type {
  CanonicalSessionEntryType,
  ConversationRecord,
  MessageRecord,
} from "../types.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";

export interface AddCanonicalMessageRequest {
  conversationId: string;
  sessionEntryId: string;
  sessionParentEntryId: string | null;
  sessionEntryType: CanonicalSessionEntryType;
  message: AgentMessage;
}

export type AddMessageResult =
  | { status: "inserted"; message: MessageRecord }
  | { status: "duplicate"; message: MessageRecord };

export interface MessageSearchResult {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  snippet: string;
  token_count: number;
  created_at: string;
}

export class ConversationStore {
  private ftsAvailable: boolean;

  constructor(
    private readonly drizzle: DrizzleDB,
    private readonly rawDb: DatabaseSync,
    hasFts5: boolean,
  ) {
    this.ftsAvailable = hasFts5;
  }

  getOrCreateConversation(sessionKey: string): ConversationRecord {
    const existing = this.drizzle
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.session_key, sessionKey),
          eq(conversations.active, 1),
        ),
      )
      .limit(1)
      .get() as ConversationRecord | undefined;
    if (existing) return existing;

    const record: ConversationRecord = {
      id: randomUUID(),
      session_key: sessionKey,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      active: 1,
    };
    this.drizzle.insert(conversations).values(record).run();
    return record;
  }

  getConversation(id: string): ConversationRecord | undefined {
    return this.drizzle
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .get() as ConversationRecord | undefined;
  }

  addMessage(request: AddCanonicalMessageRequest): AddMessageResult {
    // Stable identity is checked before allocating a local sequence or performing
    // context/FTS side effects. The unique index remains the final race guard.
    const existing = this.getMessageBySessionEntryId(
      request.conversationId,
      request.sessionEntryId,
    );
    if (existing) return { status: "duplicate", message: existing };

    const encoded = encodeCanonicalMessage(request.message);
    const record: MessageRecord = {
      id: randomUUID(),
      conversation_id: request.conversationId,
      seq: this.getLastSeq(request.conversationId) + 1,
      session_entry_id: request.sessionEntryId,
      session_parent_entry_id: request.sessionParentEntryId,
      session_entry_type: request.sessionEntryType,
      role: encoded.role,
      canonical_json: encoded.canonicalJson,
      search_text: encoded.searchText,
      token_count: encoded.tokenCount,
      identity_hash: null,
      created_at: new Date().toISOString(),
    };

    this.rawDb.exec("SAVEPOINT lcm_add_message");
    try {
      this.drizzle.insert(messages).values(record).run();
      this.drizzle
        .insert(contextItems)
        .values({
          id: randomUUID(),
          conversation_id: request.conversationId,
          ordinal: this.getNextOrdinal(request.conversationId),
          item_type: "message",
          message_id: record.id,
          summary_id: null,
        })
        .run();
      this.rawDb.exec("RELEASE SAVEPOINT lcm_add_message");
    } catch (error) {
      try {
        this.rawDb.exec(
          "ROLLBACK TO SAVEPOINT lcm_add_message; RELEASE SAVEPOINT lcm_add_message",
        );
      } catch {
        // Preserve the original insert error.
      }

      const racedInsert = this.getMessageBySessionEntryId(
        request.conversationId,
        request.sessionEntryId,
      );
      if (racedInsert) {
        return { status: "duplicate", message: racedInsert };
      }
      throw error;
    }

    if (this.ftsAvailable) {
      try {
        this.rawDb
          .prepare(
            `INSERT INTO messages_fts (rowid, search_text)
             VALUES ((SELECT rowid FROM messages WHERE id = ?), ?)`,
          )
          .run(record.id, record.search_text);
      } catch {
        this.ftsAvailable = false;
      }
    }

    return { status: "inserted", message: record };
  }

  getMessageById(id: string): MessageRecord | undefined {
    return this.drizzle
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get() as MessageRecord | undefined;
  }

  getMessageBySessionEntryId(
    conversationId: string,
    entryId: string,
  ): MessageRecord | undefined {
    return this.drizzle
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversation_id, conversationId),
          eq(messages.session_entry_id, entryId),
        ),
      )
      .get() as MessageRecord | undefined;
  }

  getPersistedSessionEntryIds(conversationId: string): Set<string> {
    const rows = this.drizzle
      .select({ id: messages.session_entry_id })
      .from(messages)
      .where(
        and(
          eq(messages.conversation_id, conversationId),
          sql`${messages.session_entry_id} IS NOT NULL`,
        ),
      )
      .all();

    return new Set(
      rows.flatMap((row) => (row.id === null ? [] : [row.id])),
    );
  }

  getMessages(conversationId: string, afterSeq?: number): MessageRecord[] {
    const condition =
      afterSeq === undefined
        ? eq(messages.conversation_id, conversationId)
        : and(
            eq(messages.conversation_id, conversationId),
            gt(messages.seq, afterSeq),
          );

    return this.drizzle
      .select()
      .from(messages)
      .where(condition)
      .orderBy(asc(messages.seq))
      .all() as MessageRecord[];
  }

  getMessageCount(conversationId: string): number {
    return (
      this.drizzle
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.conversation_id, conversationId))
        .get()?.value ?? 0
    );
  }

  getLastSeq(conversationId: string): number {
    return (
      this.drizzle
        .select({ value: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
        .from(messages)
        .where(eq(messages.conversation_id, conversationId))
        .get()?.value ?? 0
    );
  }

  searchMessages(
    query: string,
    conversationId?: string,
    limit = 20,
  ): MessageSearchResult[] {
    if (!this.ftsAvailable) {
      return this.searchLike(query, conversationId, limit);
    }

    try {
      return this.searchFts(query, conversationId, limit);
    } catch {
      this.ftsAvailable = false;
      return this.searchLike(query, conversationId, limit);
    }
  }

  private searchFts(
    query: string,
    conversationId: string | undefined,
    limit: number,
  ): MessageSearchResult[] {
    const base = `
      SELECT m.id, m.conversation_id, m.seq, m.role,
             snippet(messages_fts, 0, '[', ']', '...', 32) AS snippet,
             m.token_count, m.created_at
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE messages_fts MATCH ?`;
    const ftsQuery = sanitizeFts5Query(query);
    const rows = conversationId
      ? this.rawDb
          .prepare(
            `${base} AND m.conversation_id = ? ORDER BY rank LIMIT ?`,
          )
          .all(ftsQuery, conversationId, limit)
      : this.rawDb
          .prepare(`${base} ORDER BY rank LIMIT ?`)
          .all(ftsQuery, limit);
    return rows as unknown as MessageSearchResult[];
  }

  private searchLike(
    query: string,
    conversationId: string | undefined,
    limit: number,
  ): MessageSearchResult[] {
    const condition = conversationId
      ? and(
          eq(messages.conversation_id, conversationId),
          like(messages.search_text, `%${query}%`),
        )
      : like(messages.search_text, `%${query}%`);

    return this.drizzle
      .select({
        id: messages.id,
        conversation_id: messages.conversation_id,
        seq: messages.seq,
        role: messages.role,
        search_text: messages.search_text,
        token_count: messages.token_count,
        created_at: messages.created_at,
      })
      .from(messages)
      .where(condition)
      .orderBy(desc(messages.created_at))
      .limit(limit)
      .all()
      .map(({ search_text: searchText, ...row }) => ({
        ...row,
        snippet: this.createSnippet(searchText, query),
      }));
  }

  private createSnippet(text: string, query: string): string {
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) {
      return text.slice(0, 100) + (text.length > 100 ? "..." : "");
    }

    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, index + query.length + 50);
    return (
      (start > 0 ? "..." : "") +
      text.slice(start, end) +
      (end < text.length ? "..." : "")
    );
  }

  private getNextOrdinal(conversationId: string): number {
    const row = this.drizzle
      .select({
        value: sql<number>`COALESCE(MAX(${contextItems.ordinal}), -1)`,
      })
      .from(contextItems)
      .where(eq(contextItems.conversation_id, conversationId))
      .get();
    return (row?.value ?? -1) + 1;
  }
}
