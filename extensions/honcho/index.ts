import type {
  AgentToolResult,
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  Honcho,
  type MessageInput,
  type Peer,
  type Session,
} from "@honcho-ai/sdk";
import { isSubagent } from "../_lib/env.js";
import {
  HONCHO_DELETED_MARKER,
  HONCHO_SYNC_MARKER,
  currentMessageEntryId,
  deduplicateSections,
  getProjectMetadata,
  latestDeletedMarker,
  honchoSessionId,
  latestSyncMarker,
  loadHonchoConfig,
  resolveWithDeadline,
  safeParentSessionId,
  selectUnseenMessages,
  wrapMemoryContext,
  type DeletedMarkerData,
  type SyncMarkerData,
} from "./core.js";

const config = loadHonchoConfig();
const HONCHO_STATUS = "honcho";

type ConnectionState = "connecting" | "connected" | "unavailable" | "deleted";

interface RuntimeHandles {
  client: Honcho;
  userPeer: Peer;
  aiPeer: Peer;
  session: Session;
}

interface ToolDetails {
  status: "ok";
  count?: number;
  outputChars?: number;
  category?: string;
}

const SearchParams = Type.Object({
  query: Type.String({ description: "Natural language memory search query." }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results." }),
  ),
});
type SearchParamsType = Static<typeof SearchParams>;

const ChatParams = Type.Object({
  question: Type.String({
    description: "Question about the user's preferences, history, or decisions.",
  }),
});
type ChatParamsType = Static<typeof ChatParams>;

const InsightParams = Type.Object({
  content: Type.String({
    description: "Concrete and reusable fact, preference, correction, or decision.",
  }),
  category: Type.Optional(
    Type.String({ description: "Optional category, such as workflow or code-style." }),
  ),
});
type InsightParamsType = Static<typeof InsightParams>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateToolText(text: string): string {
  const result = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Honcho output truncated: ${result.outputLines} of ${result.totalLines} lines shown.]`;
}

function formatSearchResults(
  messages: Array<{
    content: string;
    peerId: string;
    sessionId: string;
    createdAt: string;
  }>,
): string {
  if (messages.length === 0) return "No Honcho messages matched.";
  return messages
    .map(
      (message) =>
        `- [${message.createdAt}] (${message.peerId}, session ${message.sessionId})\n${message.content}`,
    )
    .join("\n\n");
}

function branchEntries(ctx: {
  sessionManager: { getBranch(): readonly SessionEntry[] };
}): SessionEntry[] {
  return [...ctx.sessionManager.getBranch()];
}

function latestPrompt(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter(
              (part): part is { type: "text"; text: string } =>
                part.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n");
    if (text.trim()) return text.trim();
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  if (!config.enabled) return;

  let generation = 0;
  let closed = true;
  let deleted = false;
  let state: ConnectionState = "unavailable";
  let handles: RuntimeHandles | null = null;
  let initPromise: Promise<RuntimeHandles> | null = null;
  let lastInitFailureAt = 0;
  let sessionId = "";
  let piSessionId = "";
  let cachedContext: string | null = null;
  let turnCounter = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  let pendingWrites = 0;
  let lastError: string | null = null;
  let deleting = false;
  let deletionAccepted = false;
  let sessionUi: { setStatus(id: string, value: string | undefined): void } | null = null;

  const canInject = () => config.injectContext && (!isSubagent() || config.injectInSubagents);
  const canStore = () => config.storeMessages && (!isSubagent() || config.storeInSubagents);

  function statusText(): string {
    if (state === "deleted") return "🧠⛔";
    if (state === "connecting") return "🧠↻";
    if (state === "connected") return pendingWrites > 0 ? `🧠↥${pendingWrites}` : "🧠🟢";
    return "🧠🔴";
  }

  function publishStatus(): void {
    sessionUi?.setStatus(HONCHO_STATUS, statusText());
  }

  function recordError(error: unknown): void {
    lastError = describeError(error);
    if (!deleted) state = "unavailable";
    publishStatus();
  }

  function isCurrent(runGeneration: number): boolean {
    return !closed && !deleted && generation === runGeneration;
  }

  async function initialize(runGeneration: number, ctx: {
    cwd: string;
    sessionManager: {
      getSessionId(): string;
      getHeader(): { parentSession?: string } | null;
    };
  }): Promise<RuntimeHandles> {
    const localPiSessionId = ctx.sessionManager.getSessionId();
    const localSessionId = honchoSessionId(localPiSessionId);
    const project = getProjectMetadata(ctx.cwd);
    const header = ctx.sessionManager.getHeader();
    const client = new Honcho({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || undefined,
      workspaceId: config.workspace,
      timeout: config.sdkTimeoutMs,
      maxRetries: config.sdkMaxRetries,
    });
    const [userPeer, aiPeer] = await Promise.all([
      client.peer(config.userPeer, {
        metadata: { display_name: config.userPeer, source: "pi" },
      }),
      client.peer(config.aiPeer, {
        metadata: { display_name: config.aiPeer, source: "pi" },
      }),
    ]);
    if (!isCurrent(runGeneration)) {
      throw new Error("Honcho session changed during initialization");
    }
    const metadata: Record<string, unknown> = {
      source: "pi",
      name: project.projectName,
      project_name: project.projectName,
      cwd: ctx.cwd,
      git_root: project.gitRoot,
      git_branch: project.gitBranch,
      pi_session_id: localPiSessionId,
      parent_pi_session_id: safeParentSessionId(header?.parentSession),
    };
    const session = await client.session(localSessionId, { metadata });
    if (!isCurrent(runGeneration)) {
      throw new Error("Honcho session changed during initialization");
    }
    await session.setPeers([
      [userPeer, { observeMe: true, observeOthers: false }],
      [aiPeer, { observeMe: false, observeOthers: true }],
    ]);

    const result = { client, userPeer, aiPeer, session };
    if (isCurrent(runGeneration)) {
      handles = result;
      piSessionId = localPiSessionId;
      sessionId = localSessionId;
      state = "connected";
      lastError = null;
      publishStatus();
    }
    return result;
  }

  function startInitialization(
    runGeneration: number,
    ctx: Parameters<typeof initialize>[1],
  ): Promise<RuntimeHandles> {
    if (!isCurrent(runGeneration)) {
      return Promise.reject(new Error("Honcho session is closed"));
    }
    if (handles) return Promise.resolve(handles);
    if (initPromise) return initPromise;
    if (
      lastInitFailureAt > 0 &&
      Date.now() - lastInitFailureAt < config.reconnectBackoffMs
    ) {
      return Promise.reject(new Error("Honcho reconnect backoff is active"));
    }

    state = "connecting";
    publishStatus();
    const promise = initialize(runGeneration, ctx)
      .catch((error) => {
        lastInitFailureAt = Date.now();
        if (isCurrent(runGeneration)) recordError(error);
        throw error;
      })
      .finally(() => {
        if (generation === runGeneration) initPromise = null;
      });
    initPromise = promise;
    void promise.catch(() => undefined);
    return promise;
  }

  async function ensureInitialized(
    runGeneration: number,
    ctx: Parameters<typeof initialize>[1],
  ): Promise<RuntimeHandles> {
    if (deleted) throw new Error("The current Honcho session was deleted");
    if (handles && isCurrent(runGeneration)) return handles;
    return startInitialization(runGeneration, ctx);
  }

  async function fetchContext(
    runGeneration: number,
    ctx: Parameters<typeof initialize>[1] & {
      sessionManager: Parameters<typeof initialize>[1]["sessionManager"] & {
        getBranch(): readonly SessionEntry[];
      };
    },
    query: string,
  ): Promise<string | null> {
    const runtime = await ensureInitialized(runGeneration, ctx);
    const response = await runtime.session.context({
      summary: true,
      tokens: config.contextTokens,
      peerTarget: runtime.userPeer,
      peerPerspective: runtime.aiPeer,
      limitToSession: false,
      representationOptions: {
        searchQuery: query,
        searchTopK: Math.min(config.searchResults, 100),
        maxConclusions: Math.min(config.searchResults * 3, 100),
        includeMostFrequent: true,
      },
    });
    const card = response.peerCard?.join("\n") ?? null;
    const summary = response.summary?.content ?? null;
    const charBudget = Math.max(1000, config.contextTokens * 4);
    return deduplicateSections(
      [
        { heading: "Stable user card", content: card },
        { heading: "Task-relevant user representation", content: response.peerRepresentation },
        { heading: "Current session summary", content: summary },
      ],
      charBudget,
    );
  }

  function appendMarker(entryId: string | null, baseline = false): void {
    pi.appendEntry<SyncMarkerData>(HONCHO_SYNC_MARKER, {
      piSessionId,
      entryId,
      syncedAt: new Date().toISOString(),
      baseline,
    });
  }

  function ensureBaseline(ctx: {
    sessionManager: { getBranch(): readonly SessionEntry[] };
  }): void {
    if (!canStore()) return;
    const entries = branchEntries(ctx);
    if (latestSyncMarker(entries, piSessionId)) return;
    appendMarker(currentMessageEntryId(entries), true);
  }

  function queueSync(
    runGeneration: number,
    ctx: Parameters<typeof initialize>[1] & {
      sessionManager: Parameters<typeof initialize>[1]["sessionManager"] & {
        getBranch(): readonly SessionEntry[];
      };
    },
  ): void {
    if (!canStore() || !isCurrent(runGeneration)) return;
    pendingWrites += 1;
    publishStatus();

    const run = async (): Promise<void> => {
      if (!isCurrent(runGeneration)) return;
      const entries = branchEntries(ctx);
      if (!latestSyncMarker(entries, piSessionId)) {
        appendMarker(currentMessageEntryId(entries), true);
        return;
      }
      const unseen = selectUnseenMessages(
        entries,
        config.maxMessageChars,
        piSessionId,
      );
      if (unseen.length === 0) return;
      const runtime = await ensureInitialized(runGeneration, ctx);
      if (!isCurrent(runGeneration)) return;
      const messages: MessageInput[] = unseen.map((message) => {
        const peer = message.role === "user" ? runtime.userPeer : runtime.aiPeer;
        return peer.message(message.content, {
          createdAt: message.timestamp,
          metadata: {
            source: "pi",
            pi_session_id: piSessionId,
            pi_entry_id: message.entryId,
            pi_role: message.role,
          },
        });
      });
      await runtime.session.addMessages(messages);
      if (!isCurrent(runGeneration)) return;
      appendMarker(unseen.at(-1)?.entryId ?? null);
      state = "connected";
      lastError = null;
    };

    writeQueue = writeQueue
      .then(run, run)
      .catch((error) => {
        if (isCurrent(runGeneration)) recordError(error);
      })
      .finally(() => {
        pendingWrites = Math.max(0, pendingWrites - 1);
        publishStatus();
      });
  }

  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    const runGeneration = generation;
    closed = false;
    const deletionMarker = latestDeletedMarker(
      branchEntries(ctx),
      ctx.sessionManager.getSessionId(),
    );
    deleted = deletionMarker !== null;
    deletionAccepted = deletionMarker?.status === "accepted";
    deleting = false;
    state = deleted ? "deleted" : "connecting";
    handles = null;
    initPromise = null;
    lastInitFailureAt = 0;
    sessionId = honchoSessionId(ctx.sessionManager.getSessionId());
    piSessionId = ctx.sessionManager.getSessionId();
    cachedContext = null;
    turnCounter = 0;
    writeQueue = Promise.resolve();
    pendingWrites = 0;
    lastError = null;
    sessionUi = ctx.ui;
    publishStatus();
    if (!deleted) ensureBaseline(ctx);
    if (!deleted && (canInject() || canStore())) {
      void startInitialization(runGeneration, ctx).catch(() => undefined);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const runGeneration = generation;
    if (!canInject() || closed || deleted) return;
    turnCounter += 1;
    const shouldRefresh =
      turnCounter === 1 ||
      (config.refreshInterval > 0 && turnCounter % config.refreshInterval === 0);

    if (shouldRefresh) {
      const query = event.prompt.trim() || latestPrompt(branchEntries(ctx)) || "user preferences";
      const contextPromise = fetchContext(runGeneration, ctx, query)
        .then((context) => {
          if (isCurrent(runGeneration) && context) cachedContext = context;
          return context;
        })
        .catch((error) => {
          if (isCurrent(runGeneration)) recordError(error);
          return null;
        });
      const result = await resolveWithDeadline(contextPromise, config.contextDeadlineMs);
      if (result.status === "completed" && result.value && isCurrent(runGeneration)) {
        cachedContext = result.value;
      }
    }

    if (!cachedContext || !isCurrent(runGeneration)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${wrapMemoryContext(cachedContext)}`,
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    queueSync(generation, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const result = await resolveWithDeadline(writeQueue, config.shutdownDeadlineMs);
    closed = true;
    generation += 1;
    handles = null;
    initPromise = null;
    cachedContext = null;
    state = result.status === "timed-out" ? "unavailable" : state;
    ctx.ui.setStatus(HONCHO_STATUS, undefined);
    sessionUi = null;
  });

  pi.registerTool<typeof SearchParams, ToolDetails>({
    name: "honcho_search",
    label: "Honcho Search",
    description: `Search raw Honcho messages across the Pi workspace. Output is limited to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes.`,
    promptSnippet: "Search raw long-term memory messages",
    promptGuidelines: [
      "Use honcho_search when exact past wording, decisions, or events can answer the task.",
    ],
    parameters: SearchParams,
    async execute(_id, params: SearchParamsType, _signal, _update, ctx) {
      const runtime = await ensureInitialized(generation, ctx);
      const messages = await runtime.client.search(params.query, {
        limit: params.limit ?? config.searchResults,
      });
      const text = truncateToolText(formatSearchResults(messages));
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", count: messages.length, outputChars: text.length },
      } satisfies AgentToolResult<ToolDetails>;
    },
  });

  pi.registerTool<typeof ChatParams, ToolDetails>({
    name: "honcho_chat",
    label: "Honcho Chat",
    description:
      "Ask Honcho a cross-session question from the Pi peer's view of the user.",
    promptSnippet: "Ask a synthesized question about long-term user memory",
    promptGuidelines: [
      "Use honcho_chat before assuming the user's preferences, workflow, or past decisions.",
    ],
    parameters: ChatParams,
    async execute(_id, params: ChatParamsType, _signal, _update, ctx) {
      const runtime = await ensureInitialized(generation, ctx);
      const response = await runtime.aiPeer.chat(params.question, {
        target: runtime.userPeer,
        reasoningLevel: "minimal",
      });
      const text = truncateToolText(response ?? "No Honcho memory answered the question.");
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", outputChars: text.length },
      };
    },
  });

  pi.registerTool<typeof InsightParams, ToolDetails>({
    name: "honcho_save_insight",
    label: "Honcho Save Insight",
    description:
      "Save a durable fact about the user. Do not save secrets, credentials, or transient debugging output.",
    promptSnippet: "Save a durable user insight to Honcho",
    promptGuidelines: [
      "Use honcho_save_insight for concrete user preferences, corrections, workflow habits, and decisions.",
    ],
    parameters: InsightParams,
    async execute(_id, params: InsightParamsType, _signal, _update, ctx) {
      const runtime = await ensureInitialized(generation, ctx);
      const content = params.category
        ? `[category: ${params.category}] ${params.content}`
        : params.content;
      await runtime.aiPeer.conclusionsOf(runtime.userPeer).create({
        content,
        sessionId: runtime.session,
      });
      return {
        content: [{ type: "text", text: "Insight saved to Honcho." }],
        details: { status: "ok", category: params.category },
      };
    },
  });

  pi.registerCommand("honcho:status", {
    description: "Show Honcho connection, configuration, and write status",
    handler: async (_args, ctx) => {
      const lines = [
        "🧠 Honcho Status",
        `  State: ${state}`,
        `  Base URL: ${config.baseUrl}`,
        `  Workspace: ${config.workspace}`,
        `  Session: ${sessionId || "not started"}`,
        `  User peer: ${config.userPeer}`,
        `  AI peer: ${config.aiPeer}`,
        `  Context injection: ${canInject() ? "yes" : "no"}`,
        `  Transcript storage: ${canStore() ? "yes" : "no"}`,
        `  Cached context: ${cachedContext?.length ?? 0} chars`,
        `  Pending writes: ${pendingWrites}`,
        `  Last error: ${lastError ?? "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), state === "connected" ? "info" : "warning");
    },
  });

  pi.registerCommand("honcho:inspect", {
    description: "Show the Pi peer's current representation of the user",
    handler: async (args, ctx) => {
      try {
        const runtime = await ensureInitialized(generation, ctx);
        const query = args.trim();
        const representation = await runtime.aiPeer.representation({
          target: runtime.userPeer,
          searchQuery: query || undefined,
          searchTopK: config.searchResults,
          maxConclusions: Math.min(config.searchResults * 3, 100),
          includeMostFrequent: true,
        });
        ctx.ui.notify(truncateToolText(representation || "No representation found."), "info");
      } catch (error) {
        ctx.ui.notify(`Honcho inspect failed: ${describeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("honcho:save", {
    description: "Save a durable fact about the user",
    handler: async (args, ctx) => {
      const content = args.trim();
      if (!content) {
        ctx.ui.notify("Usage: /honcho:save <durable fact>", "info");
        return;
      }
      try {
        const runtime = await ensureInitialized(generation, ctx);
        await runtime.aiPeer.conclusionsOf(runtime.userPeer).create({
          content,
          sessionId: runtime.session,
        });
        ctx.ui.notify("Saved to Honcho.", "info");
      } catch (error) {
        ctx.ui.notify(`Honcho save failed: ${describeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("honcho:delete-session", {
    description: "Delete the current Honcho session and disable it until the next Pi session",
    handler: async (_args, ctx) => {
      if (deleting) {
        ctx.ui.notify("Honcho session deletion is already in progress.", "warning");
        return;
      }
      if (deleted && deletionAccepted) {
        ctx.ui.notify("The current Honcho session is already disabled.", "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Delete current Honcho session?",
        `This deletes Honcho session ${sessionId} and all its messages. It does not delete cross-session peer conclusions. This cannot be undone.`,
      );
      if (!confirmed) return;

      deleting = true;
      deleted = true;
      state = "deleted";
      publishStatus();
      pi.appendEntry<DeletedMarkerData>(HONCHO_DELETED_MARKER, {
        piSessionId,
        deletedAt: new Date().toISOString(),
        status: "requested",
      });
      const pendingInitialization = initPromise;
      const queued = writeQueue;
      generation += 1;
      cachedContext = null;
      const operations = Promise.allSettled([
        queued,
        ...(pendingInitialization ? [pendingInitialization] : []),
      ]);
      const operationDeadline = Math.max(
        config.shutdownDeadlineMs,
        config.sdkTimeoutMs * (config.sdkMaxRetries + 1),
      );
      const settled = await resolveWithDeadline(operations, operationDeadline);
      handles = null;
      initPromise = null;

      if (settled.status === "timed-out") {
        lastError = "Pending Honcho operations did not stop before the deletion deadline";
        deleting = false;
        ctx.ui.notify(
          `${lastError}. Writes remain disabled. Run /honcho:delete-session again to retry.`,
          "error",
        );
        return;
      }

      try {
        const client = new Honcho({
          baseURL: config.baseUrl,
          apiKey: config.apiKey || undefined,
          workspaceId: config.workspace,
          timeout: config.sdkTimeoutMs,
          maxRetries: config.sdkMaxRetries,
        });
        const session = await client.session(honchoSessionId(piSessionId));
        await session.delete();
        deletionAccepted = true;
        pi.appendEntry<DeletedMarkerData>(HONCHO_DELETED_MARKER, {
          piSessionId,
          deletedAt: new Date().toISOString(),
          status: "accepted",
        });
        lastError = null;
        ctx.ui.notify(
          "Current Honcho session deletion was accepted. Honcho is disabled until Pi starts another session.",
          "info",
        );
      } catch (error) {
        lastError = describeError(error);
        ctx.ui.notify(
          `Honcho session deletion failed: ${lastError}. Writes remain disabled; run the command again to retry.`,
          "error",
        );
      } finally {
        deleting = false;
      }
    },
  });
}
