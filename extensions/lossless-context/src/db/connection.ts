/**
 * SQLite database connection management for LCM.
 * Uses built-in node:sqlite (Node.js 22+) with Drizzle ORM.
 *
 * Table schema is defined in schema.ts (Drizzle source of truth).
 * Table creation DDL lives here because Drizzle doesn't generate
 * CREATE TABLE IF NOT EXISTS at runtime. FTS5 virtual tables are
 * also created here since Drizzle has no FTS5 support.
 */

import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as schema from "./schema.js";

/** Drizzle database instance type for LCM. */
export type DrizzleDB = NodeSQLiteDatabase<typeof schema>;

export class LcmDatabase {
  /** Raw node:sqlite handle (for FTS5 queries and other raw SQL). */
  public readonly db: DatabaseSync;
  /** Typed Drizzle ORM instance. */
  public readonly drizzle: DrizzleDB;
  public readonly hasFts5: boolean;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    // Expand ~ to home directory
    this.dbPath = dbPath.startsWith("~")
      ? path.join(os.homedir(), dbPath.slice(1))
      : dbPath;

    // Create parent directories if needed
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new DatabaseSync(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.exec("PRAGMA journal_mode=WAL");

    // Set busy timeout
    this.db.exec("PRAGMA busy_timeout=5000");

    // Create Drizzle instance wrapping the raw connection
    this.drizzle = drizzle({ client: this.db, schema });

    // Detect FTS5 availability
    this.hasFts5 = this.detectFts5();

    // Ensure tables exist (idempotent)
    this.ensureTables();
  }

  /**
   * Create all tables and indexes if they don't already exist.
   *
   * The canonical schema definition lives in schema.ts (Drizzle).
   * This DDL must match it — if you change schema.ts, update here too.
   */
  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        active INTEGER NOT NULL DEFAULT 1
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_session_key ON conversations(session_key)`);

    this.db.exec(`
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
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_identity_hash ON messages(identity_hash)`);

    this.db.exec(`
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
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_conversation_kind ON summaries(conversation_id, kind)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_summaries_conversation_depth ON summaries(conversation_id, depth)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summary_messages (
        summary_id TEXT NOT NULL REFERENCES summaries(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        PRIMARY KEY (summary_id, message_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summary_parents (
        summary_id TEXT NOT NULL REFERENCES summaries(id),
        parent_summary_id TEXT NOT NULL REFERENCES summaries(id),
        PRIMARY KEY (summary_id, parent_summary_id)
      )
    `);

    this.db.exec(`
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
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_context_items_conversation ON context_items(conversation_id, ordinal)`);

    this.db.exec(`
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
    if (this.hasFts5) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
          USING fts5(content, content=messages, content_rowid=rowid)
        `);
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts
          USING fts5(content, content=summaries, content_rowid=rowid)
        `);
      } catch {
        // FTS5 creation failed — stores fall back to LIKE queries
      }
    }
  }

  /**
   * Check if FTS5 is available by attempting to create a temporary FTS5 table.
   */
  private detectFts5(): boolean {
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(content)",
      );
      this.db.exec("DROP TABLE IF EXISTS _fts5_test");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get the absolute path to the database file.
   */
  getPath(): string {
    return this.dbPath;
  }
}
