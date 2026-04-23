import type { ContextItemRecord, MessageRecord, SummaryRecord, LcmConfig } from "./types.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { ContextItemsStore } from "./store/context-items-store.js";
import { formatSummariesAsMessage, formatStoredMessageAsLlmMessage } from "./message-format.js";

export interface AssembledContext {
  messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>;
  totalTokens: number;
  summaryCount: number;
  messageCount: number;
}

interface ResolvedItem {
  item: ContextItemRecord;
  kind: "message" | "summary";
  record: MessageRecord | SummaryRecord;
  tokens: number;
}

export interface AssemblerDeps {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  contextItemsStore: ContextItemsStore;
  config: LcmConfig;
}

export class ContextAssembler {
  constructor(private deps: AssemblerDeps) {}

  assemble(conversationId: string, tokenBudget: number): AssembledContext {
    const items = this.deps.contextItemsStore.getContextItems(conversationId);
    if (items.length === 0) {
      return { messages: [], totalTokens: 0, summaryCount: 0, messageCount: 0 };
    }

    // Resolve all items to their content
    const resolved = this.resolveItems(items);
    if (resolved.length === 0) {
      return { messages: [], totalTokens: 0, summaryCount: 0, messageCount: 0 };
    }

    // Split fresh tail (last freshTailCount message items)
    const { evictable, freshTail } = this.splitFreshTail(resolved);

    // Budget-aware selection
    const effectiveBudget = Math.floor(tokenBudget * this.deps.config.contextThreshold);
    const selected = this.selectWithinBudget(evictable, freshTail, effectiveBudget);

    // Build output messages
    return this.buildMessages(selected);
  }

  /**
   * Assemble only the summary prefix messages (no raw messages from DB).
   * Used by the context hook to prepend summaries to Pi's native message list,
   * which always includes the current (not-yet-stored) user message.
   */
  assembleSummariesOnly(
    conversationId: string,
    tokenBudget: number,
  ): Array<{ role: string; content: string | Array<{ type: string; text: string }> }> {
    const items = this.deps.contextItemsStore.getContextItems(conversationId);
    if (items.length === 0) return [];

    const resolved = this.resolveItems(items);
    if (resolved.length === 0) return [];

    // Only keep summary items that are outside the fresh tail
    const { evictable } = this.splitFreshTail(resolved);
    const summaryItems = evictable.filter((item) => item.kind === "summary");
    if (summaryItems.length === 0) return [];

    // Budget: reserve space for Pi's native messages (rough heuristic: use half budget for summaries)
    const summaryBudget = Math.floor(tokenBudget * this.deps.config.contextThreshold * 0.5);
    const selected: ResolvedItem[] = [];
    let usedTokens = 0;
    // Add newest-first within budget
    for (let i = summaryItems.length - 1; i >= 0; i--) {
      const item = summaryItems[i];
      if (usedTokens + item.tokens <= summaryBudget) {
        selected.unshift(item);
        usedTokens += item.tokens;
      }
    }

    if (selected.length === 0) return [];

    // Group consecutive summaries into formatted messages
    const messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }> = [];
    const pendingSummaries: SummaryRecord[] = [];

    for (const item of selected) {
      pendingSummaries.push(item.record as SummaryRecord);
    }

    if (pendingSummaries.length > 0) {
      messages.push(formatSummariesAsMessage(pendingSummaries));
    }

    return messages;
  }

  private resolveItems(items: ContextItemRecord[]): ResolvedItem[] {
    const resolved: ResolvedItem[] = [];

    for (const item of items) {
      if (item.item_type === "message" && item.message_id) {
        const msg = this.deps.conversationStore.getMessageById(item.message_id);
        if (msg) {
          resolved.push({ item, kind: "message", record: msg, tokens: msg.token_count });
        }
      } else if (item.item_type === "summary" && item.summary_id) {
        const summary = this.deps.summaryStore.getSummary(item.summary_id);
        if (summary) {
          resolved.push({ item, kind: "summary", record: summary, tokens: summary.token_count });
        }
      }
    }

    return resolved;
  }

  private splitFreshTail(resolved: ResolvedItem[]): {
    evictable: ResolvedItem[];
    freshTail: ResolvedItem[];
  } {
    const freshTailCount = this.deps.config.freshTailCount;
    const freshTailMaxTokens = this.deps.config.freshTailMaxTokens;
    const freshTail: ResolvedItem[] = [];
    const evictable: ResolvedItem[] = [];

    // Walk backwards, count message-type items for fresh tail.
    // Summaries always go to evictable — they're not native messages
    // and should always be available for injection as the historical prefix.
    // Fresh tail is bounded by both message count AND token budget.
    let messagesSeen = 0;
    let freshTailTokens = 0;
    for (let i = resolved.length - 1; i >= 0; i--) {
      const item = resolved[i];
      if (item.kind === "summary") {
        evictable.unshift(item);
        continue;
      }
      messagesSeen++;
      if (
        messagesSeen <= freshTailCount &&
        freshTailTokens + item.tokens <= freshTailMaxTokens
      ) {
        freshTail.unshift(item);
        freshTailTokens += item.tokens;
      } else {
        evictable.unshift(item);
      }
    }

    return { evictable, freshTail };
  }

  private selectWithinBudget(
    evictable: ResolvedItem[],
    freshTail: ResolvedItem[],
    budget: number,
  ): ResolvedItem[] {
    // Fresh tail is always included
    let usedTokens = freshTail.reduce((sum, item) => sum + item.tokens, 0);

    // Add evictable items newest-first until budget
    const selected: ResolvedItem[] = [];
    for (let i = evictable.length - 1; i >= 0; i--) {
      const item = evictable[i];
      if (usedTokens + item.tokens <= budget) {
        selected.unshift(item);
        usedTokens += item.tokens;
      }
    }

    // Combine: selected evictable + fresh tail (preserving order)
    return [...selected, ...freshTail];
  }

  private buildMessages(selected: ResolvedItem[]): AssembledContext {
    const messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }> = [];
    let totalTokens = 0;
    let summaryCount = 0;
    let messageCount = 0;

    // Group consecutive summaries together
    let pendingSummaries: SummaryRecord[] = [];

    const flushSummaries = () => {
      if (pendingSummaries.length > 0) {
        messages.push(formatSummariesAsMessage(pendingSummaries));
        summaryCount += pendingSummaries.length;
        pendingSummaries = [];
      }
    };

    for (const item of selected) {
      if (item.kind === "summary") {
        pendingSummaries.push(item.record as SummaryRecord);
        totalTokens += item.tokens;
      } else {
        flushSummaries();
        messages.push(formatStoredMessageAsLlmMessage(item.record as MessageRecord));
        totalTokens += item.tokens;
        messageCount++;
      }
    }

    flushSummaries();

    return { messages, totalTokens, summaryCount, messageCount };
  }
}
