import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
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
 * Replaces Pi's default sliding-window compaction with a DAG-based summarization system.
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
  let modelRegistryRef:
    | { find: Function; getApiKeyAndHeaders: Function }
    | undefined;

  /**
   * Session start: Initialize database and stores.
   */
  pi.on("session_start", async (_event, ctx) => {
    try {
      // Initialize database (constructor creates tables if needed)
      database = new LcmDatabase(config.dbPath);

      // Initialize stores
      conversationStore = new ConversationStore(database.drizzle, database.db, database.hasFts5);
      summaryStore = new SummaryStore(database.drizzle, database.db, database.hasFts5);
      contextItemsStore = new ContextItemsStore(database.drizzle, database.db);

      // Get or create conversation for this session (keyed by session file for per-session isolation)
      const sessionFile = ctx.sessionManager.getSessionFile() ?? ctx.cwd;
      const sessionKey = sessionKeyFromFile(sessionFile);
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
   */
  pi.on("turn_end", async (event, _ctx) => {
    // If the turn produced tool results, the agent was actively working
    lastTurnHadToolUse = event.toolResults.length > 0;
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
   * Context assembly: Prepend LCM summary messages to Pi's native message list.
   * We prepend rather than replace so the current user message (not yet stored in DB)
   * is always present for the LLM.
   */
  pi.on("context", async (event, ctx) => {
    if (!assembler || !conversation || !summaryStore || isCompacting) return;

    try {
      // Only inject when we have summaries
      const counts = summaryStore.getSummaryCounts(conversation.id);
      if (counts.total === 0) return;

      const tokenBudget = ctx.model?.contextWindow ?? 200000;
      const summaryMessages = assembler.assembleSummariesOnly(conversation.id, tokenBudget);

      if (summaryMessages.length > 0) {
        // Prepend summary messages to Pi's native messages (which include the current user turn)
        return { messages: [...summaryMessages, ...event.messages] as AgentMessage[] };
      }
    } catch (error) {
      console.error("LCM context error:", error);
    }
  });

  /**
   * Intercept Pi's compaction (including /compact command).
   * Run LCM's own DAG compaction, then return a summary to Pi so it has a
   * valid compaction entry. This also handles the /compact command path.
   */
  pi.on("session_before_compact", async (event, ctx) => {
    if (!compactionEngine || !summaryStore || !conversation) {
      // Not initialized — let Pi handle it normally
      return;
    }

    try {
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
