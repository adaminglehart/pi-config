import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Honcho } from "@honcho-ai/sdk";
import * as path from "path";
import * as os from "os";

// Module-level state
let enabled = false;
let client: Honcho;
let userPeerId: string;
let aiPeerId: string;
let sessionId: string;
let cachedContext: string | null = null;
let turnCounter = 0;
let pendingWrites: Promise<void>[] = [];

// Configuration
const config = {
  baseUrl: process.env.HONCHO_BASE_URL ?? "http://localhost:8100",
  workspace: process.env.HONCHO_WORKSPACE ?? "pi",
  userName: process.env.HONCHO_PEER_NAME ?? process.env.USER ?? "user",
  aiName: process.env.HONCHO_AI_PEER ?? "pi",
  contextTokens: parseInt(process.env.HONCHO_CONTEXT_TOKENS ?? "2000", 10),
  refreshInterval: parseInt(process.env.HONCHO_REFRESH_INTERVAL ?? "5", 10),
  enabled: (process.env.HONCHO_ENABLED ?? "true").toLowerCase() !== "false",
};

/**
 * Sanitize a file path to use as a session external_id
 * ~/dev/my-project → dev--my-project
 */
function sanitizePath(cwd: string): string {
  const home = os.homedir();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return relative.replace(/\//g, "--");
}

/**
 * Extract text content from message content (string or array)
 */
function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // Skip if disabled
  if (!config.enabled) return;

  // ===========================
  // Session Initialization
  // ===========================
  pi.on("session_start", async (_event, ctx) => {
    try {
      client = new Honcho({
        baseURL: config.baseUrl,
        apiKey: "none",
        workspaceId: config.workspace,
      });

      // Get or create peers
      const userPeer = await client.peer(config.userName);
      userPeerId = userPeer.id;

      const aiPeer = await client.peer(config.aiName);
      aiPeerId = aiPeer.id;

      // Get or create session from cwd
      const sessionExternalId = sanitizePath(ctx.cwd);
      const session = await client.session(sessionExternalId, {
        metadata: { name: path.basename(ctx.cwd) },
      });
      sessionId = session.id;

      // Fetch initial context using session.context() with peer representation
      try {
        const session = await client.session(sessionId);
        const sessionContext = await session.context({
          tokens: config.contextTokens,
          peerTarget: userPeerId,
        });
        // Get the peer representation from the context
        cachedContext = sessionContext.peerRepresentation || null;
      } catch {
        cachedContext = null;
      }

      enabled = true;
      turnCounter = 0;
      ctx.ui.setStatus("honcho", "🧠 Honcho: connected");
    } catch (err) {
      enabled = false;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `Honcho: unreachable (${msg}), memory disabled for this session`,
        "warning",
      );
      ctx.ui.setStatus("honcho", "🧠 Honcho: disconnected");
    }
  });

  // ===========================
  // Context Injection
  // ===========================
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled) return;

    turnCounter++;
    const shouldRefresh =
      turnCounter === 1 || turnCounter % config.refreshInterval === 0;

    if (shouldRefresh) {
      try {
        const session = await client.session(sessionId);
        const sessionContext = await session.context({
          tokens: config.contextTokens,
          peerTarget: userPeerId,
        });
        cachedContext = sessionContext.peerRepresentation || null;
      } catch {
        // Use cached on failure
      }
    }

    if (!cachedContext) return;

    // Truncate to rough token estimate
    const maxChars = config.contextTokens * 4;
    const truncated = cachedContext.slice(0, maxChars);

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## User Memory (Honcho)\nThe following is what you know about this user from previous sessions:\n\n${truncated}`,
    };
  });

  // ===========================
  // Message Storage
  // ===========================
  pi.on("agent_end", async (event, _ctx) => {
    if (!enabled) return;

    // Get peer objects
    const userPeer = await client.peer(userPeerId);
    const aiPeer = await client.peer(aiPeerId);
    const session = await client.session(sessionId);

    // Extract text messages only (skip tool calls, tool results, system)
    const messagesToCreate: any[] = [];

    for (const msg of event.messages) {
      if (msg.role === "user" && msg.content) {
        const textContent = extractTextContent(msg.content);
        if (textContent) {
          messagesToCreate.push(userPeer.message(textContent));
        }
      } else if (msg.role === "assistant" && msg.content) {
        const textContent = extractTextContent(msg.content);
        if (textContent) {
          messagesToCreate.push(aiPeer.message(textContent));
        }
      }
    }

    // Create messages in a single batch
    if (messagesToCreate.length > 0) {
      const p = session
        .addMessages(messagesToCreate)
        .catch(() => {}) as Promise<void>;
      pendingWrites.push(p);
    }
  });

  // ===========================
  // Graceful Shutdown
  // ===========================
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (!enabled) return;
    await Promise.allSettled(pendingWrites);
    pendingWrites = [];
  });

  // ===========================
  // Custom Tools
  // ===========================

  // honcho_search — Semantic search across sessions
  pi.registerTool({
    name: "honcho_search",
    label: "Honcho Search",
    description:
      "Semantic search across all Honcho sessions and messages for the current user",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!enabled) {
        return {
          content: [{ type: "text", text: "Honcho is not connected" }],
          details: {},
        };
      }
      try {
        const userPeer = await client.peer(userPeerId);
        const result = await userPeer.chat(params.query, {
          session: sessionId,
        });
        return {
          content: [{ type: "text", text: result || "No response" }],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Honcho search failed: ${msg}` }],
          details: {},
        };
      }
    },
  });

  // honcho_chat — Natural language query about the user
  pi.registerTool({
    name: "honcho_chat",
    label: "Honcho Chat",
    description:
      "Ask Honcho about the user — their preferences, patterns, past decisions",
    parameters: Type.Object({
      question: Type.String({
        description: "Natural language question about the user",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!enabled) {
        return {
          content: [{ type: "text", text: "Honcho is not connected" }],
          details: {},
        };
      }
      try {
        const userPeer = await client.peer(userPeerId);
        const result = await userPeer.chat(params.question);
        return {
          content: [{ type: "text", text: result || "No response" }],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Honcho chat failed: ${msg}` }],
          details: {},
        };
      }
    },
  });

  // honcho_save_insight — Manually save an insight
  pi.registerTool({
    name: "honcho_save_insight",
    label: "Honcho Save Insight",
    description:
      "Save a conclusion/insight about the user to Honcho's long-term memory",
    parameters: Type.Object({
      content: Type.String({ description: "The insight to save" }),
      category: Type.Optional(
        Type.String({
          description: "Category (e.g., preferences, workflow, code-style)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!enabled) {
        return {
          content: [{ type: "text", text: "Honcho is not connected" }],
          details: {},
        };
      }
      try {
        const aiPeer = await client.peer(aiPeerId);
        await aiPeer.conclusionsOf(userPeerId).create({
          content: params.content,
          sessionId: sessionId,
        });
        return {
          content: [
            { type: "text", text: `Saved insight: "${params.content}"` },
          ],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to save insight: ${msg}` }],
          details: {},
        };
      }
    },
  });

  // ===========================
  // Slash Commands
  // ===========================

  // /honcho:status — Show connection info
  pi.registerCommand("honcho:status", {
    description:
      "Show Honcho connection status, workspace, session, and peer info",
    handler: async (_args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("🧠 Honcho: disconnected", "warning");
        return;
      }
      const lines = [
        `🧠 Honcho Status`,
        `  Connected: yes`,
        `  Workspace: ${config.workspace}`,
        `  Session: ${sessionId}`,
        `  User Peer: ${userPeerId}`,
        `  AI Peer: ${aiPeerId}`,
        `  Turn: ${turnCounter}`,
        `  Cached context: ${cachedContext ? `${cachedContext.length} chars` : "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /honcho:interview — Structured Q&A to seed preferences
  pi.registerCommand("honcho:interview", {
    description:
      "Structured interview to seed user preferences into Honcho memory",
    handler: async (_args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("Honcho is not connected", "error");
        return;
      }

      const questions = [
        "What programming languages do you prefer and why?",
        "Describe your ideal code style (comments, naming, abstractions, testing).",
        "What's your git/version control workflow? (branching strategy, commit style, PR process)",
        "How do you prefer AI assistants to communicate? (concise vs detailed, when to ask vs proceed)",
        "What frameworks, tools, or patterns do you use most often?",
        "Any strong opinions about code organization, architecture, or dev practices?",
      ];

      const aiPeer = await client.peer(aiPeerId);
      const conclusionsScope = aiPeer.conclusionsOf(userPeerId);

      for (const question of questions) {
        const answer = await ctx.ui.input(question);
        if (!answer) continue;

        try {
          await conclusionsScope.create({
            content: `Q: ${question}\nA: ${answer}`,
            sessionId: sessionId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to save answer: ${msg}`, "error");
          return;
        }
      }

      ctx.ui.notify("Interview complete! Preferences saved to Honcho.", "info");
    },
  });

  // /honcho:inspect — Show raw observations with optional search filter
  pi.registerCommand("honcho:inspect", {
    description:
      "Show raw Honcho observations/facts about the user (optional: search query)",
    handler: async (args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("Honcho is not connected", "error");
        return;
      }

      try {
        const userPeer = await client.peer(userPeerId);
        const query = args?.trim() || "";
        const representation = await userPeer.representation(
          query ? { searchQuery: query } : {},
        );

        if (!representation) {
          ctx.ui.notify("No observations found", "info");
          return;
        }

        ctx.ui.notify(
          `🔍 Honcho Observations${query ? ` (filtered: "${query}")` : ""}\n\n${representation}`,
          "info",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to fetch observations: ${msg}`, "error");
      }
    },
  });

  // /honcho:save — Manually save a conclusion/fact
  pi.registerCommand("honcho:save", {
    description: "Manually save a conclusion or fact to Honcho memory",
    handler: async (args, ctx) => {
      if (!enabled) {
        ctx.ui.notify("Honcho is not connected", "error");
        return;
      }

      const content = args?.trim();
      if (!content) {
        ctx.ui.notify(
          "Usage: /honcho:save <content>\n\nExample: /honcho:save User prefers concise responses",
          "info",
        );
        return;
      }

      try {
        const aiPeer = await client.peer(aiPeerId);
        const conclusionsScope = aiPeer.conclusionsOf(userPeerId);
        await conclusionsScope.create({
          content: content,
          sessionId: sessionId,
        });
        ctx.ui.notify(`✓ Saved to Honcho: "${content}"`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to save: ${msg}`, "error");
      }
    },
  });

  // /honcho:forget — Info about clearing memory
  pi.registerCommand("honcho:forget", {
    description:
      "Show info about clearing Honcho memory (manual via API for now)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "To clear Honcho memory, use the Honcho API directly at http://localhost:8100/docs",
        "info",
      );
    },
  });
}
