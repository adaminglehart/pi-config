/**
 * Summary persistence layer for LCM.
 * Manages the summary DAG (directed acyclic graph) with leaf and condensed summaries.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SummaryRecord, SummaryKind } from "../types.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";

export class SummaryStore {
  constructor(
    private db: DatabaseSync,
    private hasFts5: boolean,
  ) {}

  /**
   * Create a leaf summary linked to source messages.
   */
  createLeafSummary(
    conversationId: string,
    content: string,
    tokenCount: number,
    sourceMessageIds: string[],
    metadata?: Record<string, unknown>,
  ): SummaryRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(metadata ?? {});

    // Insert summary
    this.db
      .prepare(
        `
        INSERT INTO summaries (id, conversation_id, kind, depth, content, token_count, metadata, created_at)
        VALUES (?, ?, 'leaf', 0, ?, ?, ?, ?)
      `,
      )
      .run(id, conversationId, content, tokenCount, metadataJson, now);

    // Link to source messages
    if (sourceMessageIds.length > 0) {
      const linkStmt = this.db.prepare(
        `
          INSERT INTO summary_messages (summary_id, message_id)
          VALUES (?, ?)
        `,
      );

      for (const messageId of sourceMessageIds) {
        linkStmt.run(id, messageId);
      }
    }

    // Update FTS5 index if available
    if (this.hasFts5) {
      try {
        this.db
          .prepare(
            `
            INSERT INTO summaries_fts (rowid, content)
            VALUES ((SELECT rowid FROM summaries WHERE id = ?), ?)
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
      kind: "leaf",
      depth: 0,
      content,
      token_count: tokenCount,
      metadata: metadataJson,
      created_at: now,
    };
  }

  /**
   * Create a condensed summary linked to source summaries.
   */
  createCondensedSummary(
    conversationId: string,
    content: string,
    tokenCount: number,
    depth: number,
    sourceSummaryIds: string[],
    metadata?: Record<string, unknown>,
  ): SummaryRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(metadata ?? {});

    // Insert summary
    this.db
      .prepare(
        `
        INSERT INTO summaries (id, conversation_id, kind, depth, content, token_count, metadata, created_at)
        VALUES (?, ?, 'condensed', ?, ?, ?, ?, ?)
      `,
      )
      .run(id, conversationId, depth, content, tokenCount, metadataJson, now);

    // Link to source summaries
    if (sourceSummaryIds.length > 0) {
      const linkStmt = this.db.prepare(
        `
          INSERT INTO summary_parents (summary_id, parent_summary_id)
          VALUES (?, ?)
        `,
      );

      for (const parentId of sourceSummaryIds) {
        linkStmt.run(id, parentId);
      }
    }

    // Update FTS5 index if available
    if (this.hasFts5) {
      try {
        this.db
          .prepare(
            `
            INSERT INTO summaries_fts (rowid, content)
            VALUES ((SELECT rowid FROM summaries WHERE id = ?), ?)
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
      kind: "condensed",
      depth,
      content,
      token_count: tokenCount,
      metadata: metadataJson,
      created_at: now,
    };
  }

  /**
   * Get summary by ID.
   */
  getSummary(summaryId: string): SummaryRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT id, conversation_id, kind, depth, content, token_count, metadata, created_at
        FROM summaries
        WHERE id = ?
      `,
      )
      .get(summaryId) as SummaryRecord | undefined;
  }

  /**
   * Get source message IDs for a leaf summary.
   */
  getSummaryMessageIds(summaryId: string): string[] {
    const rows = this.db
      .prepare(
        `
        SELECT message_id
        FROM summary_messages
        WHERE summary_id = ?
        ORDER BY message_id
      `,
      )
      .all(summaryId) as Array<{ message_id: string }>;

    return rows.map((row) => row.message_id);
  }

  /**
   * Check if a message is already covered by an existing leaf summary.
   */
  isMessageSummarized(messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM summary_messages WHERE message_id = ? LIMIT 1`,
      )
      .get(messageId) as { "1": number } | undefined;
    return row !== undefined;
  }

  /**
   * Delete all summaries and related records for a conversation.
   * Used by recompact to start fresh.
   */
  clearConversationSummaries(conversationId: string): void {
    this.db
      .prepare(
        `DELETE FROM summary_messages WHERE summary_id IN (
          SELECT id FROM summaries WHERE conversation_id = ?
        )`,
      )
      .run(conversationId);

    this.db
      .prepare(
        `DELETE FROM summary_parents WHERE summary_id IN (
          SELECT id FROM summaries WHERE conversation_id = ?
        ) OR parent_summary_id IN (
          SELECT id FROM summaries WHERE conversation_id = ?
        )`,
      )
      .run(conversationId, conversationId);

    this.db
      .prepare(`DELETE FROM summaries WHERE conversation_id = ?`)
      .run(conversationId);
  }

  /**
   * Get parent summary IDs (condensed summaries that consumed this one).
   */
  getSummaryParentIds(summaryId: string): string[] {
    const rows = this.db
      .prepare(
        `
        SELECT summary_id
        FROM summary_parents
        WHERE parent_summary_id = ?
        ORDER BY summary_id
      `,
      )
      .all(summaryId) as Array<{ summary_id: string }>;

    return rows.map((row) => row.summary_id);
  }

  /**
   * Get child summaries that reference this as parent.
   */
  getSummaryChildren(summaryId: string): SummaryRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT s.id, s.conversation_id, s.kind, s.depth, s.content, s.token_count, s.metadata, s.created_at
        FROM summaries s
        JOIN summary_parents sp ON s.id = sp.parent_summary_id
        WHERE sp.summary_id = ?
        ORDER BY s.created_at
      `,
      )
      .all(summaryId);

    return rows as unknown as SummaryRecord[];
  }

  /**
   * Get summaries at a specific depth for a conversation.
   */
  getSummariesAtDepth(conversationId: string, depth: number): SummaryRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, conversation_id, kind, depth, content, token_count, metadata, created_at
        FROM summaries
        WHERE conversation_id = ? AND depth = ?
        ORDER BY created_at
      `,
      )
      .all(conversationId, depth);

    return rows as unknown as SummaryRecord[];
  }

  /**
   * Get all summaries for a conversation.
   */
  getAllSummaries(conversationId: string): SummaryRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, conversation_id, kind, depth, content, token_count, metadata, created_at
        FROM summaries
        WHERE conversation_id = ?
        ORDER BY depth, created_at
      `,
      )
      .all(conversationId);

    return rows as unknown as SummaryRecord[];
  }

  /**
   * Get summary count by kind for a conversation.
   */
  getSummaryCounts(
    conversationId: string,
  ): { leaf: number; condensed: number; total: number } {
    const rows = this.db
      .prepare(
        `
        SELECT kind, COUNT(*) as count
        FROM summaries
        WHERE conversation_id = ?
        GROUP BY kind
      `,
      )
      .all(conversationId) as Array<{ kind: SummaryKind; count: number }>;

    const leaf = rows.find((r) => r.kind === "leaf")?.count ?? 0;
    const condensed = rows.find((r) => r.kind === "condensed")?.count ?? 0;

    return {
      leaf,
      condensed,
      total: leaf + condensed,
    };
  }

  /**
   * Search summaries (FTS5 or LIKE fallback).
   */
  searchSummaries(
    query: string,
    conversationId?: string,
    limit: number = 20,
  ): SummaryRecord[] {
    if (!query.trim()) {
      return [];
    }

    // Try FTS5 first if available
    if (this.hasFts5) {
      try {
        return this.searchSummariesFts5(query, conversationId, limit);
      } catch {
        // Fall back to LIKE search
      }
    }

    // LIKE fallback
    return this.searchSummariesLike(query, conversationId, limit);
  }

  /**
   * FTS5 search for summaries.
   */
  private searchSummariesFts5(
    query: string,
    conversationId: string | undefined,
    limit: number,
  ): SummaryRecord[] {
    const sanitizedQuery = sanitizeFts5Query(query);
    if (!sanitizedQuery) {
      return [];
    }

    const whereClauses = ["summaries_fts MATCH ?"];
    const params: Array<string | number> = [sanitizedQuery];

    if (conversationId) {
      whereClauses.push("s.conversation_id = ?");
      params.push(conversationId);
    }

    params.push(limit);

    const sql = `
      SELECT s.id, s.conversation_id, s.kind, s.depth, s.content, s.token_count, s.metadata, s.created_at
      FROM summaries_fts
      JOIN summaries s ON s.rowid = summaries_fts.rowid
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params);
    return rows as unknown as SummaryRecord[];
  }

  /**
   * LIKE fallback search for summaries.
   */
  private searchSummariesLike(
    query: string,
    conversationId: string | undefined,
    limit: number,
  ): SummaryRecord[] {
    const whereClauses = ["content LIKE ?"];
    const params: Array<string | number> = [`%${query}%`];

    if (conversationId) {
      whereClauses.push("conversation_id = ?");
      params.push(conversationId);
    }

    params.push(limit);

    const sql = `
      SELECT id, conversation_id, kind, depth, content, token_count, metadata, created_at
      FROM summaries
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params);
    return rows as unknown as SummaryRecord[];
  }
}
