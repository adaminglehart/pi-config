/**
 * Large file storage for LCM.
 * Intercepts large tool outputs and stores them externally on disk.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { LargeFileRecord, LcmConfig } from "./types.js";
import { estimateTokens } from "./tokens.js";

const LARGE_FILES_DIR = join(homedir(), ".pi", "lcm-files");

export class LargeFileStore {
  constructor(private db: DatabaseSync) {}

  /**
   * Check if content exceeds the large file threshold.
   */
  isLargeContent(content: string, config: LcmConfig): boolean {
    return estimateTokens(content) > config.largeFileTokenThreshold;
  }

  /**
   * Store a large file and return a reference.
   * Writes the content to disk and records metadata in the DB.
   */
  async storeLargeFile(
    conversationId: string,
    messageId: string | undefined,
    filePath: string | undefined,
    content: string,
  ): Promise<LargeFileRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tokenCount = estimateTokens(content);

    // Create storage directory
    await mkdir(LARGE_FILES_DIR, { recursive: true });

    // Write content to disk
    const storagePath = join(LARGE_FILES_DIR, `${id}.txt`);
    await writeFile(storagePath, content, "utf-8");

    // Create a truncated summary (first ~500 chars)
    const summary =
      content.length > 500
        ? content.slice(0, 500) +
          `\n\n[... truncated, ${tokenCount} tokens total, stored at ${storagePath}]`
        : content;

    // Insert DB record
    this.db
      .prepare(
        `
      INSERT INTO large_files (id, conversation_id, message_id, file_path, storage_path, token_count, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        conversationId,
        messageId ?? null,
        filePath ?? null,
        storagePath,
        tokenCount,
        summary,
        now,
      );

    return {
      id,
      conversation_id: conversationId,
      message_id: messageId ?? null,
      file_path: filePath ?? null,
      storage_path: storagePath,
      token_count: tokenCount,
      summary,
      created_at: now,
    };
  }

  /**
   * Get a large file record by ID.
   */
  getLargeFile(id: string): LargeFileRecord | undefined {
    const row = this.db
      .prepare(
        `
      SELECT id, conversation_id, message_id, file_path, storage_path, token_count, summary, created_at
      FROM large_files WHERE id = ?
    `,
      )
      .get(id);
    return row as unknown as LargeFileRecord | undefined;
  }

  /**
   * Get all large files for a conversation.
   */
  getLargeFiles(conversationId: string): LargeFileRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, conversation_id, message_id, file_path, storage_path, token_count, summary, created_at
      FROM large_files WHERE conversation_id = ? ORDER BY created_at ASC
    `,
      )
      .all(conversationId);
    return rows as unknown as LargeFileRecord[];
  }

  /**
   * Get count and total tokens for a conversation's large files.
   */
  getLargeFileStats(
    conversationId: string,
  ): { count: number; totalTokens: number } {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as total_tokens
      FROM large_files WHERE conversation_id = ?
    `,
      )
      .get(conversationId) as
      | { count: number; total_tokens: number }
      | undefined;
    return { count: row?.count ?? 0, totalTokens: row?.total_tokens ?? 0 };
  }
}
