import { decodeStoredMessage } from "./message-codec.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { SummaryRecord } from "./types.js";

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

export interface ExpandedMessageItem {
  type: "message";
  id: string;
  role: string;
  content: string;
  canonical: boolean;
  sessionEntryId: string | null;
  sessionParentEntryId: string | null;
  sessionEntryType: string | null;
}

export interface ExpandedSummaryItem {
  type: "summary";
  id: string;
  content: string;
  kind: string;
  depth: number;
}

export interface ExpandResult {
  items: Array<ExpandedMessageItem | ExpandedSummaryItem>;
  totalTokens: number;
}

export class RetrievalEngine {
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly summaryStore: SummaryStore,
  ) {}

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
      result.summaries = this.summaryStore
        .searchSummaries(query, conversationId, limit)
        .map((summary) => ({
          id: summary.id,
          kind: summary.kind,
          depth: summary.depth,
          snippet: summary.content.slice(0, 200),
          created_at: summary.created_at,
        }));
    }
    return result;
  }

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

  expand(summaryId: string, maxTokens: number): ExpandResult | undefined {
    const summary = this.summaryStore.getSummary(summaryId);
    if (!summary) return undefined;

    const items: ExpandResult["items"] = [];
    let totalTokens = 0;
    if (summary.kind === "leaf") {
      for (const messageId of this.summaryStore.getSummaryMessageIds(summaryId)) {
        if (totalTokens >= maxTokens) break;
        const record = this.conversationStore.getMessageById(messageId);
        if (!record) continue;

        const decoded = decodeStoredMessage(record);
        const content =
          decoded.kind === "canonical"
            ? `Canonical Pi AgentMessage:\n${JSON.stringify(decoded.message, null, 2)}`
            : `Legacy projection (not an exact original ${decoded.originalRole} message):\n${record.search_text}`;
        items.push({
          type: "message",
          id: record.id,
          role:
            decoded.kind === "canonical"
              ? decoded.message.role
              : decoded.originalRole,
          content,
          canonical: decoded.kind === "canonical",
          sessionEntryId: record.session_entry_id,
          sessionParentEntryId: record.session_parent_entry_id,
          sessionEntryType: record.session_entry_type,
        });
        totalTokens += record.token_count;
      }
    } else {
      for (const child of this.summaryStore.getSummaryChildren(summaryId)) {
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
