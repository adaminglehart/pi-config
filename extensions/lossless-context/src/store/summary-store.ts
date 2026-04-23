/**
 * Summary persistence layer for LCM.
 * Manages the summary DAG (directed acyclic graph) with leaf and condensed summaries.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { eq, and, asc, desc, sql, count, like, inArray } from "drizzle-orm";
import type { DrizzleDB } from "../db/connection.js";
import { summaries, summaryMessages, summaryParents } from "../db/schema.js";
import type { SummaryRecord, SummaryKind } from "../types.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";

export class SummaryStore {
  constructor(
    private drizzle: DrizzleDB,
    private rawDb: DatabaseSync,
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

    this.drizzle
      .insert(summaries)
      .values({
        id,
        conversation_id: conversationId,
        kind: "leaf",
        depth: 0,
        content,
        token_count: tokenCount,
        metadata: metadataJson,
        created_at: now,
      })
      .run();

    // Link to source messages
    if (sourceMessageIds.length > 0) {
      for (const messageId of sourceMessageIds) {
        this.drizzle
          .insert(summaryMessages)
          .values({ summary_id: id, message_id: messageId })
          .run();
      }
    }

    // Update FTS5 index if available
    if (this.hasFts5) {
      try {
        this.rawDb
          .prepare(
            `INSERT INTO summaries_fts (rowid, content)
             VALUES ((SELECT rowid FROM summaries WHERE id = ?), ?)`,
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

    this.drizzle
      .insert(summaries)
      .values({
        id,
        conversation_id: conversationId,
        kind: "condensed",
        depth,
        content,
        token_count: tokenCount,
        metadata: metadataJson,
        created_at: now,
      })
      .run();

    // Link to source summaries
    if (sourceSummaryIds.length > 0) {
      for (const parentId of sourceSummaryIds) {
        this.drizzle
          .insert(summaryParents)
          .values({ summary_id: id, parent_summary_id: parentId })
          .run();
      }
    }

    // Update FTS5 index if available
    if (this.hasFts5) {
      try {
        this.rawDb
          .prepare(
            `INSERT INTO summaries_fts (rowid, content)
             VALUES ((SELECT rowid FROM summaries WHERE id = ?), ?)`,
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
    return this.drizzle
      .select()
      .from(summaries)
      .where(eq(summaries.id, summaryId))
      .get() as SummaryRecord | undefined;
  }

  /**
   * Get source message IDs for a leaf summary.
   */
  getSummaryMessageIds(summaryId: string): string[] {
    const rows = this.drizzle
      .select({ message_id: summaryMessages.message_id })
      .from(summaryMessages)
      .where(eq(summaryMessages.summary_id, summaryId))
      .orderBy(asc(summaryMessages.message_id))
      .all();

    return rows.map((row) => row.message_id);
  }

  /**
   * Check if a message is already covered by an existing leaf summary.
   */
  isMessageSummarized(messageId: string): boolean {
    const row = this.drizzle
      .select({ message_id: summaryMessages.message_id })
      .from(summaryMessages)
      .where(eq(summaryMessages.message_id, messageId))
      .limit(1)
      .get();

    return row !== undefined;
  }

  /**
   * Delete all summaries and related records for a conversation.
   * Used by recompact to start fresh.
   */
  clearConversationSummaries(conversationId: string): void {
    // Get all summary IDs for this conversation
    const summaryIds = this.drizzle
      .select({ id: summaries.id })
      .from(summaries)
      .where(eq(summaries.conversation_id, conversationId))
      .all()
      .map((r) => r.id);

    if (summaryIds.length === 0) return;

    // Delete junction records
    this.drizzle
      .delete(summaryMessages)
      .where(inArray(summaryMessages.summary_id, summaryIds))
      .run();

    this.drizzle
      .delete(summaryParents)
      .where(inArray(summaryParents.summary_id, summaryIds))
      .run();

    this.drizzle
      .delete(summaryParents)
      .where(inArray(summaryParents.parent_summary_id, summaryIds))
      .run();

    // Delete summaries
    this.drizzle
      .delete(summaries)
      .where(eq(summaries.conversation_id, conversationId))
      .run();
  }

  /**
   * Get parent summary IDs (condensed summaries that consumed this one).
   */
  getSummaryParentIds(summaryId: string): string[] {
    const rows = this.drizzle
      .select({ summary_id: summaryParents.summary_id })
      .from(summaryParents)
      .where(eq(summaryParents.parent_summary_id, summaryId))
      .orderBy(asc(summaryParents.summary_id))
      .all();

    return rows.map((row) => row.summary_id);
  }

  /**
   * Get child summaries that reference this as parent.
   */
  getSummaryChildren(summaryId: string): SummaryRecord[] {
    // summary_parents.summary_id = the condensed summary
    // summary_parents.parent_summary_id = the child being referenced
    return this.drizzle
      .select({
        id: summaries.id,
        conversation_id: summaries.conversation_id,
        kind: summaries.kind,
        depth: summaries.depth,
        content: summaries.content,
        token_count: summaries.token_count,
        metadata: summaries.metadata,
        created_at: summaries.created_at,
      })
      .from(summaries)
      .innerJoin(summaryParents, eq(summaries.id, summaryParents.parent_summary_id))
      .where(eq(summaryParents.summary_id, summaryId))
      .orderBy(asc(summaries.created_at))
      .all() as SummaryRecord[];
  }

  /**
   * Get summaries at a specific depth for a conversation.
   */
  getSummariesAtDepth(conversationId: string, depth: number): SummaryRecord[] {
    return this.drizzle
      .select()
      .from(summaries)
      .where(and(eq(summaries.conversation_id, conversationId), eq(summaries.depth, depth)))
      .orderBy(asc(summaries.created_at))
      .all() as unknown as SummaryRecord[];
  }

  /**
   * Get all summaries for a conversation.
   */
  getAllSummaries(conversationId: string): SummaryRecord[] {
    return this.drizzle
      .select()
      .from(summaries)
      .where(eq(summaries.conversation_id, conversationId))
      .orderBy(asc(summaries.depth), asc(summaries.created_at))
      .all() as unknown as SummaryRecord[];
  }

  /**
   * Get summary count by kind for a conversation.
   */
  getSummaryCounts(
    conversationId: string,
  ): { leaf: number; condensed: number; total: number } {
    const rows = this.drizzle
      .select({ kind: summaries.kind, count: count() })
      .from(summaries)
      .where(eq(summaries.conversation_id, conversationId))
      .groupBy(summaries.kind)
      .all() as Array<{ kind: SummaryKind; count: number }>;

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

    if (this.hasFts5) {
      try {
        return this.searchSummariesFts5(query, conversationId, limit);
      } catch {
        // Fall back to LIKE search
      }
    }

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

    const rawSql = `
      SELECT s.id, s.conversation_id, s.kind, s.depth, s.content, s.token_count, s.metadata, s.created_at
      FROM summaries_fts
      JOIN summaries s ON s.rowid = summaries_fts.rowid
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.rawDb.prepare(rawSql).all(...params);
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
    const likePattern = `%${query}%`;

    if (conversationId) {
      return this.drizzle
        .select()
        .from(summaries)
        .where(and(eq(summaries.conversation_id, conversationId), like(summaries.content, likePattern)))
        .orderBy(desc(summaries.created_at))
        .limit(limit)
        .all() as unknown as SummaryRecord[];
    }

    return this.drizzle
      .select()
      .from(summaries)
      .where(like(summaries.content, likePattern))
      .orderBy(desc(summaries.created_at))
      .limit(limit)
      .all() as unknown as SummaryRecord[];
  }
}
