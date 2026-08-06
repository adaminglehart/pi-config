import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { LcmDatabase } from "../db/connection.js";
import { LCM_SCHEMA_VERSION, migrateLcmDatabase } from "../db/migration.js";

function hasFts5(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE _fts_probe USING fts5(content)");
    db.exec("DROP TABLE _fts_probe");
    return true;
  } catch {
    return false;
  }
}

function createV1Database(db: DatabaseSync, fts5: boolean): void {
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_conversations_session_key ON conversations(session_key);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      identity_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_messages_conversation_seq
      ON messages(conversation_id, seq);
    CREATE INDEX idx_messages_identity_hash ON messages(identity_hash);
    CREATE TABLE summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      kind TEXT NOT NULL CHECK(kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE summary_messages (
      summary_id TEXT NOT NULL REFERENCES summaries(id),
      message_id TEXT NOT NULL REFERENCES messages(id),
      PRIMARY KEY (summary_id, message_id)
    );
    CREATE TABLE summary_parents (
      summary_id TEXT NOT NULL REFERENCES summaries(id),
      parent_summary_id TEXT NOT NULL REFERENCES summaries(id),
      PRIMARY KEY (summary_id, parent_summary_id)
    );
    CREATE TABLE context_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('message', 'summary')),
      message_id TEXT REFERENCES messages(id),
      summary_id TEXT REFERENCES summaries(id),
      UNIQUE(conversation_id, ordinal)
    );
    CREATE TABLE large_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      message_id TEXT REFERENCES messages(id),
      file_path TEXT,
      storage_path TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO conversations(id, session_key) VALUES ('conversation-1', 'session');
    INSERT INTO messages(
      id, conversation_id, seq, role, content, token_count, identity_hash
    ) VALUES (
      'message-1', 'conversation-1', 1, 'assistant',
      'legacy searchable projection', 7, 'old-hash'
    );
    INSERT INTO summaries(
      id, conversation_id, kind, depth, content, token_count
    ) VALUES ('summary-1', 'conversation-1', 'leaf', 0, 'summary', 2);
    INSERT INTO summary_messages(summary_id, message_id)
      VALUES ('summary-1', 'message-1');
    INSERT INTO context_items(
      id, conversation_id, ordinal, item_type, message_id
    ) VALUES ('context-1', 'conversation-1', 0, 'message', 'message-1');
    INSERT INTO large_files(
      id, conversation_id, message_id, storage_path
    ) VALUES ('file-1', 'conversation-1', 'message-1', '/tmp/file');
  `);

  if (fts5) {
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts
        USING fts5(content, content=messages, content_rowid=rowid);
      CREATE VIRTUAL TABLE summaries_fts
        USING fts5(content, content=summaries, content_rowid=rowid);
      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
    `);
  }
}

describe("LCM v2 migration", () => {
  it("migrates linked v1 data, rebuilds FTS, and is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    const fts5 = hasFts5(db);
    createV1Database(db, fts5);

    migrateLcmDatabase(db, fts5);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      LCM_SCHEMA_VERSION,
    );

    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as {
      id: string;
      search_text: string;
      canonical_json: string | null;
      session_entry_id: string | null;
      session_parent_entry_id: string | null;
      session_entry_type: string | null;
    };
    assert.equal(row.id, "message-1");
    assert.equal(row.search_text, "legacy searchable projection");
    assert.equal(row.canonical_json, null);
    assert.equal(row.session_entry_id, null);
    assert.equal(row.session_parent_entry_id, null);
    assert.equal(row.session_entry_type, null);

    for (const [table, column] of [
      ["summary_messages", "message_id"],
      ["context_items", "message_id"],
      ["large_files", "message_id"],
    ]) {
      const linked = db
        .prepare(`SELECT ${column} AS message_id FROM ${table}`)
        .get() as { message_id: string };
      assert.equal(linked.message_id, "message-1");
    }

    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'",
      )
      .all() as Array<{ name: string; sql: string | null }>;
    assert.equal(indexes.some((index) => index.name === "idx_messages_identity_hash"), false);
    assert.match(
      indexes.find(
        (index) => index.name === "idx_messages_conversation_session_entry",
      )?.sql ?? "",
      /WHERE session_entry_id IS NOT NULL/i,
    );

    db.exec(`
      INSERT INTO messages(
        id, conversation_id, seq, session_entry_id, role, search_text
      ) VALUES ('message-2', 'conversation-1', 2, 'entry-x', 'user', 'x');
    `);
    assert.throws(() =>
      db.exec(`
        INSERT INTO messages(
          id, conversation_id, seq, session_entry_id, role, search_text
        ) VALUES ('message-3', 'conversation-1', 3, 'entry-x', 'user', 'x');
      `),
    );
    db.exec(`
      INSERT INTO messages(id, conversation_id, seq, role, search_text)
        VALUES ('legacy-2', 'conversation-1', 4, 'user', 'legacy two');
      INSERT INTO messages(id, conversation_id, seq, role, search_text)
        VALUES ('legacy-3', 'conversation-1', 5, 'user', 'legacy three');
    `);

    if (fts5) {
      const match = db
        .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?")
        .all("searchable");
      assert.equal(match.length, 1);
    }

    const before = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
      count: number;
    };
    migrateLcmDatabase(db, fts5);
    const after = db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
      count: number;
    };
    assert.deepEqual(after, before);
  });

  it("creates a fresh database directly at v2", () => {
    const lcm = new LcmDatabase(":memory:");
    const version = lcm.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const columns = lcm.db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
    }>;
    assert.equal(version.user_version, LCM_SCHEMA_VERSION);
    assert.equal(columns.some((column) => column.name === "search_text"), true);
    assert.equal(columns.some((column) => column.name === "content"), false);
    lcm.close();
  });
});
