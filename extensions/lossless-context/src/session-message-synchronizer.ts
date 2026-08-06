import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ConversationStore } from "./store/conversation-store.js";

type SessionManager = ExtensionContext["sessionManager"];

export interface SynchronizationResult {
  inserted: number;
  duplicates: number;
  skipped: number;
  failed: number;
  pendingFinalizedMessages: number;
  pendingEntries: number;
  safeForContextReplacement: boolean;
}

function isPersistedMessageEndRole(role: AgentMessage["role"]): boolean {
  return role === "user" || role === "assistant" || role === "toolResult";
}

/**
 * Incrementally copies authoritative post-startup session messages into LCM.
 * Existing entries are seeded as seen; historical import is deliberately Plan 2.
 */
export class SessionMessageSynchronizer {
  private readonly seenEntryIds = new Set<string>();
  private pendingFinalizedMessages = 0;

  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly conversationId: string,
    entriesPresentAtStartup: readonly SessionEntry[],
  ) {
    for (const entry of entriesPresentAtStartup) {
      this.seenEntryIds.add(entry.id);
    }
  }

  noteFinalizedMessage(message: AgentMessage): void {
    if (isPersistedMessageEndRole(message.role)) {
      this.pendingFinalizedMessages++;
    }
  }

  syncNewEntries(sessionManager: SessionManager): SynchronizationResult {
    const entries = sessionManager.getEntries();
    let inserted = 0;
    let duplicates = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of entries) {
      if (this.seenEntryIds.has(entry.id)) continue;

      if (entry.type !== "message" && entry.type !== "custom_message") {
        this.seenEntryIds.add(entry.id);
        skipped++;
        continue;
      }

      try {
        const message = this.messageFromEntry(entry);
        const result = this.conversationStore.addMessage({
          conversationId: this.conversationId,
          sessionEntryId: entry.id,
          sessionParentEntryId: entry.parentId,
          sessionEntryType: entry.type,
          message,
        });

        if (result.status === "inserted") inserted++;
        else duplicates++;

        this.seenEntryIds.add(entry.id);
        if (
          entry.type === "message" &&
          isPersistedMessageEndRole(entry.message.role) &&
          this.pendingFinalizedMessages > 0
        ) {
          this.pendingFinalizedMessages--;
        }
      } catch {
        // Stop so a failed earlier entry remains retryable without reordering later
        // entries in LCM's local sequence.
        failed++;
        break;
      }
    }

    const pendingEntries = entries.reduce(
      (count, entry) => count + (this.seenEntryIds.has(entry.id) ? 0 : 1),
      0,
    );
    return {
      inserted,
      duplicates,
      skipped,
      failed,
      pendingFinalizedMessages: this.pendingFinalizedMessages,
      pendingEntries,
      safeForContextReplacement:
        failed === 0 &&
        pendingEntries === 0 &&
        this.pendingFinalizedMessages === 0,
    };
  }

  getPendingFinalizedMessageCount(): number {
    return this.pendingFinalizedMessages;
  }

  private messageFromEntry(
    entry: Extract<SessionEntry, { type: "message" | "custom_message" }>,
  ): AgentMessage {
    if (entry.type === "message") return entry.message;

    const projected = sessionEntryToContextMessages(entry);
    if (projected.length !== 1 || projected[0]?.role !== "custom") {
      throw new Error("Unexpected custom_message projection");
    }
    return projected[0];
  }
}
