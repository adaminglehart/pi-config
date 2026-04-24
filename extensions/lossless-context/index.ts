import type {
  ExtensionAPI,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { appendFileSync } from "node:fs";
import { loadLcmConfig } from "./src/config.js";
import { LcmDatabase } from "./src/db/connection.js";
import { ConversationStore } from "./src/store/conversation-store.js";
import { SummaryStore } from "./src/store/summary-store.js";
import { ContextItemsStore } from "./src/store/context-items-store.js";
import { CompactionEngine } from "./src/compaction.js";
import { ContextAssembler } from "./src/assembler.js";
import { RetrievalEngine } from "./src/retrieval.js";
import { registerGrepTool } from "./src/tools/lcm-grep.js";
import { registerDescribeTool } from "./src/tools/lcm-describe.js";
import { registerExpandTool } from "./src/tools/lcm-expand.js";
import { registerExpandQueryTool } from "./src/tools/lcm-expand-query.js";
import { registerCommands } from "./src/commands.js";
import { sessionKeyFromFile } from "./src/session-key.js";
import {
  extractTextContent,
  computeIdentityHash,
} from "./src/message-utils.js";
import { estimateTokens } from "./src/tokens.js";
import type { ConversationRecord } from "./src/types.js";
import { LargeFileStore } from "./src/large-files.js";
import { IntegrityChecker } from "./src/integrity.js";

/**
 * Lossless Context Management Extension
 *
 * Replaces Pi's default compaction with a DAG-based summarization system.
 * Stores every message in SQLite, creates hierarchical summaries (leaf → condensed),
 * and assembles context from summaries + recent messages on each turn.
 *
 * Phase 6: Large file handling - intercepts large tool outputs and stores them externally.
 * Phase 7: DAG integrity checking and repair.
 */
export default function (pi: ExtensionAPI) {
  const config = loadLcmConfig();

  // Early exit if disabled
  if (!config.enabled) {
    return;
  }

  // Module-level state
  let database: LcmDatabase | undefined;
  let conversationStore: ConversationStore | undefined;
  let summaryStore: SummaryStore | undefined;
  let contextItemsStore: ContextItemsStore | undefined;
  let compactionEngine: CompactionEngine | undefined;
  let assembler: ContextAssembler | undefined;
  let retrievalEngine: RetrievalEngine | undefined;
  let largeFileStore: LargeFileStore | undefined;
  let integrityChecker: IntegrityChecker | undefined;
  let conversation: ConversationRecord | undefined;
  let isCompacting = false;
  let lastTurnHadToolUse = false;
  let modelRegistryRef: ModelRegistry | undefined;

  // Background compaction state
  let backgroundCompactionPromise: Promise<void> | undefined;
  let lastKnownContextWindow = 200000;

  // Pi's context usage metrics (from getContextUsage)
  let lastKnownContextTokens = 0;
  let lastKnownContextPercent = 0;

  /**
   * Get active context token count from Pi's measurement (not LCM's DB).
   * This ensures we use the actual context size Pi is working with.
   */
  function getActiveContextTokens(_conversationId: string): number {
    // Use Pi's reported context usage, not our own calculation
    return lastKnownContextTokens;
  }

  /**
   * Return only the suffix of Pi messages that LCM has not persisted yet.
   * The context hook fires before the current user turn is always available in
   * LCM's DB, so replacing Pi's message array with only assembled DB context
   * can accidentally drop the live prompt. Keep just the new tail, not the full
   * Pi history.
   */
  function extractAgentMessageText(message: AgentMessage): string {
    if (!("content" in message)) return "";

    const { content } = message;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "toolCall") {
        parts.push(`[tool: ${block.name}]`);
      }
    }
    return parts.join("\n");
  }

  function getUnstoredEventTail(messages: AgentMessage[]): AgentMessage[] {
    if (!conversationStore || !conversation) return [];

    const storedHashes = new Set(
      conversationStore
        .getMessages(conversation.id)
        .map((message) => message.identity_hash)
        .filter((hash): hash is string => typeof hash === "string" && hash.length > 0),
    );

    const tail: AgentMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as AgentMessage | undefined;
      if (!message) continue;

      const content = extractAgentMessageText(message);
      if (!content || content.trim().length === 0) continue;

      const hash = computeIdentityHash(message.role, content);
      if (storedHashes.has(hash)) break;
      tail.unshift(message);
    }

    return tail;
  }

  const LCM_LOG = "/tmp/lcm-debug.log";
  function lcmLog(_msg: string): void {
    // no-op — remove the line below to re-enable debug logging to /tmp/lcm-debug.log
    void _msg;
    void LCM_LOG;
  }

  /**
   * Start background compaction if tokens exceed soft threshold.
   * Called after turns complete (not on the hot path of context assembly).
   */
  function maybeStartBackgroundCompaction(ctx: {
    ui: { setStatus: (id: string, status: string) => void };
  }): void {
    // Early returns for conditions that prevent background compaction
    if (!config.backgroundCompaction) {
      lcmLog("[DEBUG] backgroundCompaction disabled");
      return;
    }
    if (isCompacting) {
      lcmLog("[DEBUG] already compacting");
      return;
    }
    if (backgroundCompactionPromise) {
      lcmLog("[DEBUG] background compaction in flight");
      return;
    }
    if (!compactionEngine || !conversation) {
      lcmLog("[DEBUG] no compaction engine or conversation");
      return;
    }

    const activeTokens = getActiveContextTokens(conversation.id);
    const softThreshold = Math.floor(
      config.softTokenThreshold * lastKnownContextWindow,
    );

    lcmLog(
      `[DEBUG] activeTokens=${activeTokens}, softThreshold=${softThreshold} (window=${lastKnownContextWindow}, threshold=${config.softTokenThreshold})`,
    );

    // Below soft threshold — no compaction needed
    if (activeTokens < softThreshold) {
      lcmLog("[DEBUG] below threshold, skipping");
      return;
    }

    // Start background compaction
    ctx.ui.setStatus("lcm", "LCM 🟡 preparing summaries");

    backgroundCompactionPromise = (async () => {
      try {
        isCompacting = true;
        await compactionEngine!.runCompaction(conversation!.id);
        ctx.ui.setStatus("lcm", "LCM 🟢");
      } catch (error) {
        console.error("LCM background compaction error:", error);
        ctx.ui.setStatus("lcm", "LCM 🔴 error");
      } finally {
        isCompacting = false;
        backgroundCompactionPromise = undefined;
      }
    })();
  }

  /**
   * Session start: Initialize database and stores.
   */
  pi.on("session_start", async (_event, ctx) => {
    try {
      // Initialize database (constructor creates tables if needed)
      database = new LcmDatabase(config.dbPath);

      // Initialize stores
      conversationStore = new ConversationStore(
        database.drizzle,
        database.db,
        database.hasFts5,
      );
      summaryStore = new SummaryStore(
        database.drizzle,
        database.db,
        database.hasFts5,
      );
      contextItemsStore = new ContextItemsStore(database.drizzle, database.db);

      // Get or create conversation for this session (keyed by session file for per-session isolation)
      const sessionFile = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
      const sessionKey = sessionKeyFromFile(sessionFile);
      lcmLog(`[SESSION] file=${sessionFile}, key=${sessionKey}`);
      conversation = conversationStore.getOrCreateConversation(sessionKey);

      // Initialize compaction engine
      compactionEngine = new CompactionEngine({
        conversationStore,
        summaryStore,
        contextItemsStore,
        config,
        modelRegistry: ctx.modelRegistry,
      });

      // Initialize context assembler
      assembler = new ContextAssembler({
        conversationStore,
        summaryStore,
        contextItemsStore,
        config,
      });

      // Initialize retrieval engine
      retrievalEngine = new RetrievalEngine(conversationStore, summaryStore);

      // Initialize large file store and integrity checker
      largeFileStore = new LargeFileStore(database.db);
      integrityChecker = new IntegrityChecker(database.db);

      // Store model registry reference for tools
      modelRegistryRef = ctx.modelRegistry;

      // Set status indicator
      ctx.ui.setStatus("lcm", "LCM 🟢");
    } catch (error) {
      ctx.ui.setStatus("lcm", "LCM 🔴");
      console.error("LCM session_start error:", error);
    }
  });

  /**
   * Message end: Persist every message to SQLite.
   */
  pi.on("message_end", async (event, _ctx) => {
    if (!conversationStore || !conversation) {
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = event.message as any;

      // Extract text content from message
      const content = extractTextContent(msg);

      // Skip empty/whitespace-only messages
      if (!content || content.trim().length === 0) {
        return;
      }

      // Compute identity hash for deduplication
      const hash = computeIdentityHash(msg.role, content);

      // Estimate token count
      const tokens = estimateTokens(content);

      // Persist message (also creates context_item and updates FTS5)
      conversationStore.addMessage(
        conversation.id,
        msg.role,
        content,
        tokens,
        hash,
      );
    } catch (error) {
      console.error("LCM message_end error:", error);
    }
  });

  /**
   * Turn end: Track whether the agent was mid-task (using tools).
   * This is used to decide whether to auto-continue after compaction.
   * Also triggers background compaction if soft threshold is exceeded.
   */
  pi.on("turn_end", async (event, ctx) => {
    // If the turn produced tool results, the agent was actively working
    lastTurnHadToolUse = event.toolResults.length > 0;

    // Trigger background compaction check after turn completes
    lcmLog("[DEBUG] turn_end fired");
    maybeStartBackgroundCompaction(ctx);
  });

  /**
   * After compaction completes, send a continuation message so the agent
   * resumes work if it was mid-task. Pi's threshold auto-compaction does not
   * auto-retry by design, but LCM compaction should be seamless when the
   * agent was actively using tools.
   */
  pi.on("session_compact", async (event, _ctx) => {
    if (!event.fromExtension) return;
    if (!lastTurnHadToolUse) return;

    // Reset the flag
    lastTurnHadToolUse = false;

    // Send a user message to kick the agent back into action.
    // This is queued and processed after the compaction pipeline completes.
    pi.sendUserMessage(
      "Context was automatically compacted. Your conversation history is preserved in summaries above. Continue with your current task.",
      { deliverAs: "followUp" },
    );
  });

  /**
   * Context assembly: Replace Pi's full history with summaries + fresh tail.
   * This reduces context usage by dropping old messages that have been compacted.
   */
  pi.on("context", async (event, ctx) => {
    if (!assembler || !conversation || !summaryStore || isCompacting) return;

    // Track context window and usage for threshold calculations
    lastKnownContextWindow = ctx.model?.contextWindow ?? 200000;
    const contextUsage = (ctx as any).getContextUsage?.();
    if (contextUsage) {
      lastKnownContextTokens = contextUsage.tokens ?? lastKnownContextTokens;
      lastKnownContextPercent = contextUsage.percent ?? lastKnownContextPercent;
      lcmLog(`[CONTEXT] tokens=${contextUsage.tokens}, percent=${contextUsage.percent?.toFixed(1)}%, window=${contextUsage.contextWindow}`);
    } else {
      lcmLog(`[CONTEXT] getContextUsage not available, using fallback`);
    }

    try {
      const counts = summaryStore.getSummaryCounts(conversation.id);
      if (counts.total === 0) return; // No summaries yet, let Pi handle context normally

      const tokenBudget = ctx.model?.contextWindow ?? 200000;

      // Get properly assembled context: summaries + fresh tail (budget-aware)
      const assembled = assembler.assemble(conversation.id, tokenBudget);

      if (assembled.messages.length > 0) {
        const unstoredTail = getUnstoredEventTail(event.messages as AgentMessage[]);
        lcmLog(`[CONTEXT] assembled ${assembled.messages.length} messages (${assembled.totalTokens} tokens), ${assembled.summaryCount} summaries, ${assembled.messageCount} fresh messages, ${unstoredTail.length} unstored tail messages`);
        // Return LCM-assembled context plus the current not-yet-persisted turn.
        return {
          messages: [...assembled.messages, ...unstoredTail] as AgentMessage[],
        };
      }
    } catch (error) {
      console.error("LCM context error:", error);
    }
  });

  /**
   * Intercept Pi's compaction (including /compact command).
   * Run LCM's own DAG compaction, then return a summary to Pi so it has a
   * valid compaction entry. This also handles the /compact command path.
   *
   * Hard threshold safety: if background compaction is in-flight, await it.
   * If tokens are now below hard threshold, return without blocking.
   * Otherwise, run blocking compaction.
   */
  pi.on("session_before_compact", async (event, ctx) => {
    if (!compactionEngine || !summaryStore || !conversation) {
      // Not initialized — let Pi handle it normally
      return;
    }

    try {
      // If background compaction is in-flight, await it first.
      // Only skip blocking compaction when that in-flight work brought us
      // below the hard threshold; otherwise preserve the original hard-stop
      // behavior for Pi-triggered auto-compaction and manual /compact.
      let awaitedBackgroundCompaction = false;
      if (backgroundCompactionPromise) {
        ctx.ui.setStatus("lcm", "🟡 LCM awaiting background compaction...");
        awaitedBackgroundCompaction = true;
        await backgroundCompactionPromise;
      }

      if (awaitedBackgroundCompaction) {
        const activeTokens = getActiveContextTokens(conversation.id);
        const hardThreshold = Math.floor(
          config.hardTokenThreshold * lastKnownContextWindow,
        );

        if (activeTokens < hardThreshold) {
          const counts = summaryStore.getSummaryCounts(conversation.id);
          const summary =
            `[LCM] Background compaction already completed. ` +
            `${counts.leaf} leaf summaries, ${counts.condensed} condensed summaries. ` +
            `Full message history is preserved in the LCM database.`;

          ctx.ui.setStatus("lcm", "🟢 LCM active");

          return {
            compaction: {
              summary,
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        }
      }

      // No background compaction was available, or it was not enough — run blocking compaction.
      ctx.ui.setStatus("lcm", "🟡 LCM compacting...");
      isCompacting = true;

      await compactionEngine.runCompaction(conversation.id);

      const counts = summaryStore.getSummaryCounts(conversation.id);
      const summary =
        `[LCM] DAG compaction complete. ` +
        `${counts.leaf} leaf summaries, ${counts.condensed} condensed summaries. ` +
        `Full message history is preserved in the LCM database and accessible via lcm_grep, lcm_expand.`;

      ctx.ui.setStatus("lcm", "🟢 LCM active");

      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch (error) {
      console.error("LCM session_before_compact error:", error);
      ctx.ui.setStatus("lcm", "🔴 LCM error");
      // Fall through to Pi's default compaction on error
    } finally {
      isCompacting = false;
    }
  });

  /**
   * Tool result: Intercept large tool outputs and store them externally.
   */
  pi.on("tool_result", async (event, _ctx) => {
    if (!largeFileStore || !conversation) return;

    // Check if any text content exceeds the large file threshold
    for (const block of event.content) {
      if (block.type === "text" && typeof block.text === "string") {
        if (largeFileStore.isLargeContent(block.text, config)) {
          // Store the large content externally
          const record = await largeFileStore.storeLargeFile(
            conversation.id,
            undefined, // no message_id yet
            undefined, // extract file path from tool args if available
            block.text,
          );

          // Replace inline content with summary + reference
          return {
            content: event.content.map((b) => {
              if (b === block) {
                return {
                  type: "text" as const,
                  text: `[Large output stored externally]\n\n${record.summary}\n\nFile ID: ${record.id}\nStorage: ${record.storage_path}\nUse lcm_describe with this file ID to see details.`,
                };
              }
              return b;
            }),
          };
        }
      }
    }
  });

  /**
   * Session shutdown: Clean up resources.
   */
  pi.on("session_shutdown", async () => {
    try {
      database?.close();
    } catch (error) {
      console.error("LCM session_shutdown error:", error);
    } finally {
      database = undefined;
      conversationStore = undefined;
      summaryStore = undefined;
      contextItemsStore = undefined;
      compactionEngine = undefined;
      assembler = undefined;
      retrievalEngine = undefined;
      largeFileStore = undefined;
      integrityChecker = undefined;
      conversation = undefined;
      isCompacting = false;
      lastTurnHadToolUse = false;
      modelRegistryRef = undefined;
    }
  });

  // ── Tool Registration ─────────────────────────────────────────────────────

  // Getter closures for accessing current state in tools
  const getEngine = () => retrievalEngine;
  const getConversationId = () => conversation?.id;
  const getConfig = () => config;
  const getModelRegistry = () => modelRegistryRef;

  // Register all retrieval tools
  registerGrepTool(pi, getEngine, getConversationId);
  registerDescribeTool(pi, getEngine);
  registerExpandTool(pi, getEngine, getConfig);
  registerExpandQueryTool(
    pi,
    getEngine,
    getConversationId,
    getConfig,
    getModelRegistry,
  );

  // Register /lcm commands
  registerCommands(pi, {
    getDatabase: () => database,
    getConversationStore: () => conversationStore,
    getSummaryStore: () => summaryStore,
    getContextItemsStore: () => contextItemsStore,
    getIntegrityChecker: () => integrityChecker,
    getLargeFileStore: () => largeFileStore,
    getAssembler: () => assembler,
    getCompactionEngine: () => compactionEngine,
    getConversation: () => conversation,
    getConfig: () => config,
  });
}
