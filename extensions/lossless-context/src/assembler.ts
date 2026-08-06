import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  formatStoredMessageAsLlmMessage,
  formatSummariesAsMessage,
} from "./message-format.js";
import { validateMessageSequence } from "./message-sequence.js";
import type { ContextItemsStore } from "./store/context-items-store.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type {
  ContextItemRecord,
  LcmConfig,
  MessageRecord,
  SummaryRecord,
} from "./types.js";

interface AssembledContextBase {
  totalTokens: number;
  summaryCount: number;
  messageCount: number;
}

export type AssembledContext =
  | (AssembledContextBase & { valid: true; messages: AgentMessage[] })
  | (AssembledContextBase & {
      valid: false;
      messages: [];
      reason: string;
    });

type ResolvedItem =
  | {
      item: ContextItemRecord;
      kind: "message";
      record: MessageRecord;
      tokens: number;
    }
  | {
      item: ContextItemRecord;
      kind: "summary";
      record: SummaryRecord;
      tokens: number;
    };

export interface AssemblerDeps {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  contextItemsStore: ContextItemsStore;
  config: LcmConfig;
}

const EMPTY_CONTEXT: AssembledContext = {
  valid: true,
  messages: [],
  totalTokens: 0,
  summaryCount: 0,
  messageCount: 0,
};

export class ContextAssembler {
  constructor(private readonly deps: AssemblerDeps) {}

  assemble(conversationId: string, tokenBudget: number): AssembledContext {
    const items = this.deps.contextItemsStore.getContextItems(conversationId);
    if (items.length === 0) return EMPTY_CONTEXT;

    const resolved = this.resolveItems(items);
    if (resolved.length === 0) return EMPTY_CONTEXT;

    const { evictable, freshTail } = this.splitFreshTail(resolved);
    const effectiveBudget = Math.floor(
      tokenBudget * this.deps.config.contextThreshold,
    );
    const selected = this.selectWithinBudget(
      evictable,
      freshTail,
      effectiveBudget,
    );
    return this.buildMessages(selected);
  }

  assembleSummariesOnly(
    conversationId: string,
    tokenBudget: number,
  ): AgentMessage[] {
    const items = this.deps.contextItemsStore.getContextItems(conversationId);
    const resolved = this.resolveItems(items);
    const { evictable } = this.splitFreshTail(resolved);
    const summaries = evictable.filter(
      (item): item is Extract<ResolvedItem, { kind: "summary" }> =>
        item.kind === "summary",
    );

    const budget = Math.floor(
      tokenBudget * this.deps.config.contextThreshold * 0.5,
    );
    const selected: SummaryRecord[] = [];
    let usedTokens = 0;
    for (let index = summaries.length - 1; index >= 0; index--) {
      const item = summaries[index];
      if (usedTokens + item.tokens <= budget) {
        selected.unshift(item.record);
        usedTokens += item.tokens;
      }
    }
    return selected.length === 0 ? [] : [formatSummariesAsMessage(selected)];
  }

  private resolveItems(items: ContextItemRecord[]): ResolvedItem[] {
    const resolved: ResolvedItem[] = [];
    for (const item of items) {
      if (item.item_type === "message" && item.message_id) {
        const record = this.deps.conversationStore.getMessageById(
          item.message_id,
        );
        if (record) {
          resolved.push({
            item,
            kind: "message",
            record,
            tokens: record.token_count,
          });
        }
      } else if (item.item_type === "summary" && item.summary_id) {
        const record = this.deps.summaryStore.getSummary(item.summary_id);
        if (record) {
          resolved.push({
            item,
            kind: "summary",
            record,
            tokens: record.token_count,
          });
        }
      }
    }
    return resolved;
  }

  private splitFreshTail(resolved: ResolvedItem[]): {
    evictable: ResolvedItem[];
    freshTail: ResolvedItem[];
  } {
    const freshTail: ResolvedItem[] = [];
    const evictable: ResolvedItem[] = [];
    let messagesSeen = 0;
    let freshTailTokens = 0;

    for (let index = resolved.length - 1; index >= 0; index--) {
      const item = resolved[index];
      if (item.kind === "summary") {
        evictable.unshift(item);
        continue;
      }

      messagesSeen++;
      if (
        messagesSeen <= this.deps.config.freshTailCount &&
        freshTailTokens + item.tokens <= this.deps.config.freshTailMaxTokens
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
    let usedTokens = freshTail.reduce((sum, item) => sum + item.tokens, 0);
    const selected: ResolvedItem[] = [];

    for (let index = evictable.length - 1; index >= 0; index--) {
      const item = evictable[index];
      if (usedTokens + item.tokens <= budget) {
        selected.unshift(item);
        usedTokens += item.tokens;
      }
    }
    return [...selected, ...freshTail];
  }

  private buildMessages(selected: ResolvedItem[]): AssembledContext {
    const output: AgentMessage[] = [];
    let pendingSummaries: SummaryRecord[] = [];
    let totalTokens = 0;
    let summaryCount = 0;
    let messageCount = 0;

    const flushSummaries = (): void => {
      if (pendingSummaries.length === 0) return;
      output.push(formatSummariesAsMessage(pendingSummaries));
      summaryCount += pendingSummaries.length;
      pendingSummaries = [];
    };

    for (const item of selected) {
      totalTokens += item.tokens;
      if (item.kind === "summary") {
        pendingSummaries.push(item.record);
      } else {
        flushSummaries();
        output.push(formatStoredMessageAsLlmMessage(item.record));
        messageCount++;
      }
    }
    flushSummaries();

    const sequence = validateMessageSequence(output);
    if (!sequence.valid) {
      return {
        valid: false,
        messages: [],
        reason: sequence.reason,
        totalTokens,
        summaryCount,
        messageCount,
      };
    }
    return {
      valid: true,
      messages: output,
      totalTokens,
      summaryCount,
      messageCount,
    };
  }
}
