/**
 * Retrieval engine for Phase 5: Tools for searching and drilling into historical context.
 * Provides grep, describe, and expand operations over the summary DAG.
 */

import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { MessageRecord, SummaryRecord } from "./types.js";

export interface GrepResult {
  messages: Array<{
    id: string;
    seq: number;
    role: string;
    snippet: string;
    created_at: string;
  }>;
  summaries: Array<{
    id: string;
    kind: string;
    depth: number;
    snippet: string;
    created_at: string;
  }>;
}

export interface DescribeResult {
  summary: SummaryRecord;
  parentIds: string[];
  childSummaries: SummaryRecord[];
  sourceMessageIds: string[];
}

export interface ExpandResult {
  items: Array<{
    type: "message" | "summary";
    id: string;
    content: string;
    role?: string;
    kind?: string;
    depth?: number;
  }>;
  totalTokens: number;
}

/**
 * RetrievalEngine provides the core logic for tools.
 */
export class RetrievalEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
  ) {}

  /**
   * Search across messages and summaries with optional scope filtering.
   */
  grep(
    query: string,
    conversationId: string,
    scope: "messages" | "summaries" | "both",
    limit: number,
  ): GrepResult {
    const result: GrepResult = { messages: [], summaries: [] };

    if (scope === "messages" || scope === "both") {
      result.messages = this.conversationStore.searchMessages(
        query,
        conversationId,
        limit,
      );
    }

    if (scope === "summaries" || scope === "both") {
      const summaries = this.summaryStore.searchSummaries(
        query,
        conversationId,
        limit,
      );
      result.summaries = summaries.map((s) => ({
        id: s.id,
        kind: s.kind,
        depth: s.depth,
        snippet: s.content.slice(0, 200),
        created_at: s.created_at,
      }));
    }

    return result;
  }

  /**
   * Get full metadata and lineage for a specific summary.
   */
  describe(summaryId: string): DescribeResult | undefined {
    const summary = this.summaryStore.getSummary(summaryId);
    if (!summary) return undefined;

    return {
      summary,
      parentIds: this.summaryStore.getSummaryParentIds(summaryId),
      childSummaries: this.summaryStore.getSummaryChildren(summaryId),
      sourceMessageIds:
        summary.kind === "leaf"
          ? this.summaryStore.getSummaryMessageIds(summaryId)
          : [],
    };
  }

  /**
   * Drill into a summary to recover original detail.
   * For leaf summaries: returns source messages.
   * For condensed summaries: returns child summaries.
   */
  expand(summaryId: string, maxTokens: number): ExpandResult | undefined {
    const summary = this.summaryStore.getSummary(summaryId);
    if (!summary) return undefined;

    const items: ExpandResult["items"] = [];
    let totalTokens = 0;

    if (summary.kind === "leaf") {
      // Expand leaf → show source messages
      const messageIds = this.summaryStore.getSummaryMessageIds(summaryId);
      for (const msgId of messageIds) {
        if (totalTokens >= maxTokens) break;
        const msg = this.conversationStore.getMessageById(msgId);
        if (msg) {
          items.push({
            type: "message",
            id: msg.id,
            content: msg.content,
            role: msg.role,
          });
          totalTokens += msg.token_count;
        }
      }
    } else {
      // Expand condensed → show child summaries
      const children = this.summaryStore.getSummaryChildren(summaryId);
      for (const child of children) {
        if (totalTokens >= maxTokens) break;
        items.push({
          type: "summary",
          id: child.id,
          content: child.content,
          kind: child.kind,
          depth: child.depth,
        });
        totalTokens += child.token_count;
      }
    }

    return { items, totalTokens };
  }
}
