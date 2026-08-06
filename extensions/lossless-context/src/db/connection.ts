import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as schema from "./schema.js";
import { migrateLcmDatabase } from "./migration.js";

export type DrizzleDB = NodeSQLiteDatabase<typeof schema>;

export class LcmDatabase {
  public readonly db: DatabaseSync;
  public readonly drizzle: DrizzleDB;
  public readonly hasFts5: boolean;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath.startsWith("~")
      ? path.join(os.homedir(), dbPath.slice(1))
      : dbPath;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.hasFts5 = this.detectFts5();
    migrateLcmDatabase(this.db, this.hasFts5);
    this.drizzle = drizzle({ client: this.db, schema });
  }

  private detectFts5(): boolean {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_test USING fts5(content)");
      this.db.exec("DROP TABLE IF EXISTS _fts5_test");
      return true;
    } catch {
      return false;
    }
  }

  close(): void { this.db.close(); }
  getPath(): string { return this.dbPath; }
}
