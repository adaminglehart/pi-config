/**
 * Compaction engine for LCM.
 * Orchestrates leaf and condensed summarization passes.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { LcmConfig } from "./types.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { ContextItemsStore } from "./store/context-items-store.js";
import { summarize } from "./summarize.js";
import {
  serializeMessagesForSummary,
  serializeSummariesForCondensation,
} from "./serialize-messages.js";
import { estimateTokens } from "./tokens.js";

export interface CompactionDeps {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  contextItemsStore: ContextItemsStore;
  config: LcmConfig;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
}

export class CompactionEngine {
  constructor(private deps: CompactionDeps) {}

  /**
   * Check if compaction is needed.
   * Returns true if total stored context tokens exceed the threshold,
   * OR if there are enough raw messages outside the fresh tail to warrant a leaf pass.
   */
  shouldCompact(conversationId: string, tokenBudget: number): boolean {
    const contextItems =
      this.deps.contextItemsStore.getContextItems(conversationId);

    if (contextItems.length === 0) return false;

    const freshTailCount = this.deps.config.freshTailCount;
    const freshTailStart = Math.max(0, contextItems.length - freshTailCount);
    const threshold = tokenBudget * this.deps.config.contextThreshold;

    // Count total tokens across all context items (messages + summaries)
    let totalTokens = 0;
    // Count raw message tokens outside fresh tail (leaf pass trigger)
    let evictableMessageTokens = 0;

    for (let i = 0; i < contextItems.length; i++) {
      const item = contextItems[i];
      if (!item) continue;

      if (item.item_type === "message" && item.message_id) {
        const message = this.deps.conversationStore.getMessageById(item.message_id);
        if (message) {
          totalTokens += message.token_count;
          if (
            i < freshTailStart &&
            !this.deps.summaryStore.isMessageSummarized(item.message_id)
          ) {
            evictableMessageTokens += message.token_count;
          }
        }
      } else if (item.item_type === "summary" && item.summary_id) {
        const summary = this.deps.summaryStore.getSummary(item.summary_id);
        if (summary) {
          totalTokens += summary.token_count;
        }
      }
    }

    // Trigger if total context exceeds threshold OR there are enough raw messages to leaf-compact
    const overThreshold = totalTokens > threshold;
    const hasLeafWork = evictableMessageTokens >= this.deps.config.leafChunkTokens;

    return overThreshold || hasLeafWork;
  }

  /**
   * Run full compaction pass (leaf + optional condensed).
   */
  async runCompaction(conversationId: string): Promise<void> {
    // Run leaf pass to summarize raw messages
    await this.runLeafPass(conversationId);

    // Run condensed passes if configured
    if (this.deps.config.incrementalMaxDepth >= 1) {
      await this.runCondensedPass(conversationId, 1);
    }
  }

  /**
   * Leaf pass: summarize raw messages into leaf summaries.
   */
  private async runLeafPass(conversationId: string): Promise<void> {
    const contextItems =
      this.deps.contextItemsStore.getContextItems(conversationId);

    // Calculate fresh tail boundary
    const freshTailCount = this.deps.config.freshTailCount;
    const freshTailStart = Math.max(0, contextItems.length - freshTailCount);

    // Collect evictable message items (outside fresh tail)
    // Skip messages already covered by an existing summary to prevent duplicates
    const evictableItems = contextItems
      .slice(0, freshTailStart)
      .filter(
        (item) =>
          item.item_type === "message" &&
          item.message_id &&
          !this.deps.summaryStore.isMessageSummarized(item.message_id),
      );

    if (evictableItems.length < this.deps.config.leafMinFanout) {
      // Not enough messages to compact
      return;
    }

    // Group evictable messages into chunks
    const chunks = this.chunkMessagesByTokens(
      evictableItems,
      this.deps.config.leafChunkTokens,
    );

    // Merge the last chunk into the previous one if it's below minimum fanout.
    // This prevents orphaned message context items that would be re-summarized
    // on subsequent compaction passes.
    if (
      chunks.length >= 2 &&
      chunks[chunks.length - 1].messageIds.length < this.deps.config.leafMinFanout
    ) {
      const last = chunks.pop()!;
      const prev = chunks[chunks.length - 1];
      prev.messageIds.push(...last.messageIds);
      prev.ordinals.push(...last.ordinals);
    }

    // Process each chunk
    for (const chunk of chunks) {
      if (chunk.messageIds.length < this.deps.config.leafMinFanout) {
        // Skip chunks below minimum fanout (only possible with a single small chunk)
        continue;
      }

      // Fetch full message content
      const messages = chunk.messageIds
        .map((id) => this.deps.conversationStore.getMessageById(id))
        .filter(
          (msg): msg is NonNullable<typeof msg> => msg !== undefined,
        );

      if (messages.length === 0) {
        continue;
      }

      // Serialize messages
      const serialized = serializeMessagesForSummary(
        messages.map((m) => ({ role: m.role, content: m.content })),
      );

      // Call LLM to summarize
      const summaryContent = await summarize(
        serialized,
        "leaf",
        0,
        {
          modelRegistry: this.deps.modelRegistry,
          config: this.deps.config,
          signal: this.deps.signal,
        },
        false, // not aggressive
      );

      // Estimate token count of summary
      const summaryTokens = estimateTokens(summaryContent);

      // Create leaf summary
      const summary = this.deps.summaryStore.createLeafSummary(
        conversationId,
        summaryContent,
        summaryTokens,
        chunk.messageIds,
      );

      // Replace context items: remove message ordinals, add summary
      const removeOrdinals = chunk.ordinals;
      this.deps.contextItemsStore.replaceContextItems(
        conversationId,
        removeOrdinals,
        [{ itemType: "summary", summaryId: summary.id }],
      );
    }
  }

  /**
   * Condensed pass: summarize same-depth summaries into higher-depth.
   */
  private async runCondensedPass(
    conversationId: string,
    targetDepth: number,
  ): Promise<void> {
    const contextItems =
      this.deps.contextItemsStore.getContextItems(conversationId);

    // Get summary items at depth targetDepth-1
    const sourceDepth = targetDepth - 1;
    const sourceSummaryItems = contextItems.filter((item) => {
      if (item.item_type !== "summary" || !item.summary_id) {
        return false;
      }
      const summary = this.deps.summaryStore.getSummary(item.summary_id);
      return summary && summary.depth === sourceDepth;
    });

    // Check minimum fanout
    if (
      sourceSummaryItems.length < this.deps.config.condensedMinFanout
    ) {
      return;
    }

    // Fetch full summary records
    const summaries = sourceSummaryItems
      .map((item) =>
        item.summary_id
          ? this.deps.summaryStore.getSummary(item.summary_id)
          : undefined,
      )
      .filter(
        (summary): summary is NonNullable<typeof summary> =>
          summary !== undefined,
      );

    if (summaries.length === 0) {
      return;
    }

    // Serialize summaries
    const serialized = serializeSummariesForCondensation(
      summaries.map((s) => ({ content: s.content, depth: s.depth })),
    );

    // Call LLM to summarize
    const condensedContent = await summarize(
      serialized,
      "condensed",
      targetDepth,
      {
        modelRegistry: this.deps.modelRegistry,
        config: this.deps.config,
        signal: this.deps.signal,
      },
      false,
    );

    // Estimate token count
    const condensedTokens = estimateTokens(condensedContent);

    // Create condensed summary
    const summary = this.deps.summaryStore.createCondensedSummary(
      conversationId,
      condensedContent,
      condensedTokens,
      targetDepth,
      summaries.map((s) => s.id),
    );

    // Replace context items
    const removeOrdinals = sourceSummaryItems.map((item) => item.ordinal);
    this.deps.contextItemsStore.replaceContextItems(
      conversationId,
      removeOrdinals,
      [{ itemType: "summary", summaryId: summary.id }],
    );
  }

  /**
   * Group message items into chunks by token count.
   */
  private chunkMessagesByTokens(
    items: Array<{
      ordinal: number;
      message_id: string | null;
    }>,
    chunkTokens: number,
  ): Array<{ messageIds: string[]; ordinals: number[] }> {
    const chunks: Array<{ messageIds: string[]; ordinals: number[] }> =
      [];
    let currentChunk: { messageIds: string[]; ordinals: number[] } = {
      messageIds: [],
      ordinals: [],
    };
    let currentTokens = 0;

    for (const item of items) {
      if (!item.message_id) {
        continue;
      }

      const message = this.deps.conversationStore.getMessageById(
        item.message_id,
      );
      if (!message) {
        continue;
      }

      // If adding this message would exceed chunk limit, start new chunk
      if (
        currentTokens + message.token_count > chunkTokens &&
        currentChunk.messageIds.length > 0
      ) {
        chunks.push(currentChunk);
        currentChunk = { messageIds: [], ordinals: [] };
        currentTokens = 0;
      }

      // Add message to current chunk
      currentChunk.messageIds.push(message.id);
      currentChunk.ordinals.push(item.ordinal);
      currentTokens += message.token_count;
    }

    // Add final chunk if non-empty
    if (currentChunk.messageIds.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }
}
