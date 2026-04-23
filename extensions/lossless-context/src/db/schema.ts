/**
 * Drizzle ORM schema definitions for LCM.
 *
 * Field names use snake_case to match existing record types in types.ts,
 * avoiding a cascading refactor of all consumers.
 *
 * FTS5 virtual tables are NOT managed by Drizzle — they require raw SQL
 * in migration.ts.
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Conversations ────────────────────────────────────────────────────────────

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    session_key: text("session_key").notNull(),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updated_at: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    active: integer("active").notNull().default(1),
  },
  (t) => [index("idx_conversations_session_key").on(t.session_key)],
);

// ── Messages ─────────────────────────────────────────────────────────────────

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    token_count: integer("token_count").notNull().default(0),
    identity_hash: text("identity_hash"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("idx_messages_conversation_seq").on(t.conversation_id, t.seq),
    index("idx_messages_identity_hash").on(t.identity_hash),
  ],
);

// ── Summaries ────────────────────────────────────────────────────────────────

export const summaries = sqliteTable(
  "summaries",
  {
    id: text("id").primaryKey(),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    kind: text("kind").notNull(), // 'leaf' | 'condensed'
    depth: integer("depth").notNull().default(0),
    content: text("content").notNull(),
    token_count: integer("token_count").notNull().default(0),
    metadata: text("metadata").default("{}"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("idx_summaries_conversation_kind").on(t.conversation_id, t.kind),
    index("idx_summaries_conversation_depth").on(t.conversation_id, t.depth),
  ],
);

// ── Summary ↔ Message junction (leaf → raw messages) ─────────────────────────

export const summaryMessages = sqliteTable(
  "summary_messages",
  {
    summary_id: text("summary_id")
      .notNull()
      .references(() => summaries.id),
    message_id: text("message_id")
      .notNull()
      .references(() => messages.id),
  },
  (t) => [primaryKey({ columns: [t.summary_id, t.message_id] })],
);

// ── Summary ↔ Parent junction (condensed → child summaries) ──────────────────

export const summaryParents = sqliteTable(
  "summary_parents",
  {
    summary_id: text("summary_id")
      .notNull()
      .references(() => summaries.id),
    parent_summary_id: text("parent_summary_id")
      .notNull()
      .references(() => summaries.id),
  },
  (t) => [primaryKey({ columns: [t.summary_id, t.parent_summary_id] })],
);

// ── Context Items ────────────────────────────────────────────────────────────

export const contextItems = sqliteTable(
  "context_items",
  {
    id: text("id").primaryKey(),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    ordinal: integer("ordinal").notNull(),
    item_type: text("item_type").notNull(), // 'message' | 'summary'
    message_id: text("message_id").references(() => messages.id),
    summary_id: text("summary_id").references(() => summaries.id),
  },
  (t) => [
    uniqueIndex("idx_context_items_unique_ordinal").on(
      t.conversation_id,
      t.ordinal,
    ),
    index("idx_context_items_conversation").on(t.conversation_id, t.ordinal),
  ],
);

// ── Large Files ──────────────────────────────────────────────────────────────

export const largeFiles = sqliteTable("large_files", {
  id: text("id").primaryKey(),
  conversation_id: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
  message_id: text("message_id").references(() => messages.id),
  file_path: text("file_path"),
  storage_path: text("storage_path").notNull(),
  token_count: integer("token_count").notNull().default(0),
  summary: text("summary"),
  created_at: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
