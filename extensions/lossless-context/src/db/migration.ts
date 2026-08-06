import type { DatabaseSync } from "node:sqlite";

export const LCM_SCHEMA_VERSION = 2;

interface TableInfoRow {
  name: string;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
    )
    .get(tableName) as TableInfoRow | undefined;
  return row !== undefined;
}

function getMessageColumns(db: DatabaseSync): Set<string> {
  if (!tableExists(db, "messages")) return new Set();
  const rows = db
    .prepare("PRAGMA table_info(messages)")
    .all() as unknown as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function createCoreSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_session_key
      ON conversations(session_key);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL,
      session_entry_id TEXT,
      session_parent_entry_id TEXT,
      session_entry_type TEXT,
      role TEXT NOT NULL,
      canonical_json TEXT,
      search_text TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      identity_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
      ON messages(conversation_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_session_entry
      ON messages(conversation_id, session_entry_id)
      WHERE session_entry_id IS NOT NULL;
    DROP INDEX IF EXISTS idx_messages_identity_hash;

    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      kind TEXT NOT NULL CHECK(kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_summaries_conversation_kind
      ON summaries(conversation_id, kind);
    CREATE INDEX IF NOT EXISTS idx_summaries_conversation_depth
      ON summaries(conversation_id, depth);

    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id TEXT NOT NULL REFERENCES summaries(id),
      message_id TEXT NOT NULL REFERENCES messages(id),
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id TEXT NOT NULL REFERENCES summaries(id),
      parent_summary_id TEXT NOT NULL REFERENCES summaries(id),
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    CREATE TABLE IF NOT EXISTS context_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('message', 'summary')),
      message_id TEXT REFERENCES messages(id),
      summary_id TEXT REFERENCES summaries(id),
      UNIQUE(conversation_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_context_items_conversation
      ON context_items(conversation_id, ordinal);

    CREATE TABLE IF NOT EXISTS large_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      message_id TEXT REFERENCES messages(id),
      file_path TEXT,
      storage_path TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function ensureFts(
  db: DatabaseSync,
  hasFts5: boolean,
  rebuildMessages: boolean,
): void {
  if (!hasFts5) return;

  const messagesFtsExisted = tableExists(db, "messages_fts");
  const summariesFtsExisted = tableExists(db, "summaries_fts");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(search_text, content=messages, content_rowid=rowid);
    CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts
      USING fts5(content, content=summaries, content_rowid=rowid);
  `);
  if (rebuildMessages || !messagesFtsExisted) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }
  if (!summariesFtsExisted) {
    db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES ('rebuild')");
  }
}

function migrateV1ToV2(db: DatabaseSync, hasFts5: boolean): void {
  if (tableExists(db, "messages_fts")) {
    db.exec("DROP TABLE messages_fts");
  }
  db.exec(`
    ALTER TABLE messages RENAME COLUMN content TO search_text;
    ALTER TABLE messages ADD COLUMN canonical_json TEXT;
    ALTER TABLE messages ADD COLUMN session_entry_id TEXT;
    ALTER TABLE messages ADD COLUMN session_parent_entry_id TEXT;
    ALTER TABLE messages ADD COLUMN session_entry_type TEXT;
    DROP INDEX IF EXISTS idx_messages_identity_hash;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_session_entry
      ON messages(conversation_id, session_entry_id)
      WHERE session_entry_id IS NOT NULL;
  `);
  createCoreSchema(db);
  ensureFts(db, hasFts5, true);
}

/**
 * Bring a fresh, unversioned v1, or existing v2 database to the latest schema.
 * Schema changes are intentionally independent of Plan 3's FK/transaction policy.
 */
export function migrateLcmDatabase(db: DatabaseSync, hasFts5: boolean): void {
  const userVersion = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (userVersion > LCM_SCHEMA_VERSION) {
    throw new Error(
      `LCM database schema version ${userVersion} is newer than supported`,
    );
  }

  const columns = getMessageColumns(db);
  const isFresh = columns.size === 0;
  const isV1 = columns.has("content") && !columns.has("search_text");
  const isV2 = columns.has("search_text");

  db.exec("BEGIN IMMEDIATE");
  try {
    if (isFresh) {
      createCoreSchema(db);
      ensureFts(db, hasFts5, false);
    } else if (isV1) {
      migrateV1ToV2(db, hasFts5);
    } else if (isV2) {
      createCoreSchema(db);
      ensureFts(db, hasFts5, false);
    } else {
      throw new Error("LCM messages table has an unrecognized schema");
    }
    db.exec(`PRAGMA user_version=${LCM_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  }
}
