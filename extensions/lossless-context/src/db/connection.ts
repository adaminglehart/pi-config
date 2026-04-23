/**
 * SQLite database connection management for LCM.
 * Uses built-in node:sqlite (Node.js 22+) with Drizzle ORM.
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
