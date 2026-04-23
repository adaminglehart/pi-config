/**
 * Database schema migrations for LCM.
 * Ported from lossless-claw with all tables and indexes.
 */

import type { LcmDatabase } from "./connection.js";

/**
 * Run all schema migrations.
 * This is idempotent and can be called on every connection.
 */
export function runMigrations(lcmDb: LcmDatabase): void {
  const { db, hasFts5 } = lcmDb;

  // Conversations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_session_key 
    ON conversations(session_key)
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      identity_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq 
    ON messages(conversation_id, seq)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_identity_hash 
    ON messages(identity_hash)
  `);

  // Summaries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      kind TEXT NOT NULL CHECK(kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summaries_conversation_kind 
    ON summaries(conversation_id, kind)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summaries_conversation_depth 
    ON summaries(conversation_id, depth)
  `);

  // Summary-message junction table (leaf → raw messages)
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id TEXT NOT NULL REFERENCES summaries(id),
      message_id TEXT NOT NULL REFERENCES messages(id),
      PRIMARY KEY (summary_id, message_id)
    )
  `);

  // Summary-parent junction table (condensed → child summaries)
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id TEXT NOT NULL REFERENCES summaries(id),
      parent_summary_id TEXT NOT NULL REFERENCES summaries(id),
      PRIMARY KEY (summary_id, parent_summary_id)
    )
  `);

  // Context items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('message', 'summary')),
      message_id TEXT REFERENCES messages(id),
      summary_id TEXT REFERENCES summaries(id),
      UNIQUE(conversation_id, ordinal)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_conversation 
    ON context_items(conversation_id, ordinal)
  `);

  // Large files table
  db.exec(`
    CREATE TABLE IF NOT EXISTS large_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      message_id TEXT REFERENCES messages(id),
      file_path TEXT,
      storage_path TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // FTS5 virtual tables (only if available)
  if (hasFts5) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts 
        USING fts5(content, content=messages, content_rowid=rowid)
      `);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts 
        USING fts5(content, content=summaries, content_rowid=rowid)
      `);
    } catch (error) {
      // FTS5 creation failed - tables will fall back to LIKE queries
      console.warn("FTS5 table creation failed:", error);
    }
  }
}
