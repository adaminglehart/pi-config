import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Honcho } from "@honcho-ai/sdk";
import * as path from "node:path";
import * as os from "node:os";
import { getNamespacedConfig } from "../_lib/settings.js";

// Module-level state
let enabled = false;
let client: Honcho;
let userPeerId: string;
let aiPeerId: string;
let sessionId: string;
let cachedContext: string | null = null;
let turnCounter = 0;
let pendingWrites: Promise<void>[] = [];

// Eager promises for parallel fetching
let eagerContextPromise: Promise<string | null> | null = null;

// Configuration - read from Pi settings
const config = getNamespacedConfig("honcho", {
  baseUrl: "http://localhost:8100",
  workspace: "pi",
  userName: process.env.USER ?? "user",
  aiName: "pi",
  contextTokens: 8000,
  refreshInterval: 5,
  enabled: true,
});

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
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    text = texts.length > 0 ? texts.join("\n") : null;
  }
  // Reject whitespace-only content (Honcho API rejects it)
  if (text !== null && text.trim().length === 0) return null;
  return text;
}

export default function (pi: ExtensionAPI) {
  // Skip if disabled
  if (!config.enabled) return;

  // ===========================
  // Helper: Fetch layered context from Honcho
  // ===========================
  async function fetchLayeredContext(): Promise<string | null> {
    if (!client || !sessionId || !userPeerId) return null;

    try {
      const session = await client.session(sessionId);
      const sessionContext = await session.context({
        tokens: config.contextTokens,
        peerTarget: userPeerId,
      });

      // Use peer_card from context response (free, no extra LLM call)
      // peer_card is a structured array of traits/preferences/instructions
      const peerCard = sessionContext.peerCard;
      const cardText =
        peerCard && peerCard.length > 0 ? peerCard.join("\n") : null;

      return buildLayeredContext(
        sessionContext.peerRepresentation || null,
        cardText,
      );
    } catch {
      return null;
    }
  }

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

      // Kick off eager context fetch (don't await - let it run in parallel)
      eagerContextPromise = fetchLayeredContext();

      enabled = true;
      turnCounter = 0;
      ctx.ui.setStatus("honcho", "🧠🟢");
    } catch (err) {
      enabled = false;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(
        `Honcho: unreachable (${msg}), memory disabled for this session`,
        "warning",
      );
      ctx.ui.setStatus("honcho", "🧠🔴");
    }
  });

  // ===========================
  // Context Injection
  // ===========================
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;

    turnCounter++;
    // disable refreshing after first turn for now
    const shouldRefresh = turnCounter === 1;
    // const shouldRefresh =
    //   turnCounter === 1 || turnCounter % config.refreshInterval === 0;

    if (shouldRefresh) {
      // Await the eager promise from session_start (or kick off new one on refresh)
      try {
        if (eagerContextPromise && turnCounter === 1) {
          // First turn: await the eager promise started in session_start
          cachedContext = await eagerContextPromise;
          eagerContextPromise = null; // Clear it after first use
        } else {
          // Subsequent refreshes: fetch synchronously
          cachedContext = await fetchLayeredContext();
        }
      } catch {
        // Use cached on failure
      }
    }

    if (!cachedContext) return;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## User Memory (Honcho)\nThe following is what you know about this user from previous sessions:\n\n${cachedContext}`,
    };
  });

  // ===========================
  // Helper to build and truncate layered context
  // ===========================
  function buildLayeredContext(
    representation: string | null,
    chatResult: string | null,
  ): string | null {
    if (!representation && !chatResult) return null;

    // Split token budget: 60% for representation, 40% for chat
    // This ensures we always have parts of both context sources
    const repChars = Math.floor(config.contextTokens * 0.4 * 4);
    const chatChars = Math.floor(config.contextTokens * 0.6 * 4);

    let contextParts: string[] = [];

    if (representation) {
      contextParts.push(representation.slice(0, repChars));
    }
    if (chatResult) {
      contextParts.push(
        `## Synthesized Context\nBased on ${config.userName}'s project history and recorded interactions, here is a concise summary of their key preferences, workflow, and context:\n\n${chatResult.slice(0, chatChars)}`,
      );
    }

    return contextParts.join("\n\n");
  }

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

  // honcho_chat — Natural language query about the user
  pi.registerTool({
    name: "honcho_chat",
    label: "Honcho Chat",
    description:
      "Query long-term memory about this user. Use this before making assumptions about the user's preferences, workflow, or past decisions — especially at the start of a task, when choosing between approaches, or when you're unsure how the user likes things done. Returns synthesized knowledge from all past sessions.",
    promptSnippet: "Query long-term memory about the user's preferences, workflow, and past decisions",
    promptGuidelines: [
      "Use honcho_chat before making assumptions about the user's preferences or workflow.",
      "Query at the start of tasks, when choosing between approaches, or when unsure how the user likes things done.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "Natural language question about the user, e.g. 'What is the user\'s preferred git workflow?' or 'How does the user like code to be structured?'",
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
        const result = await userPeer.chat(params.question, {
          reasoningLevel: "minimal",
        });
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
      "Persist a new insight or conclusion about the user to long-term memory. Call this PROACTIVELY whenever you learn something durable: when the user corrects you, expresses a preference, makes a decision, pushes back on an approach, or reveals a workflow habit. Save concrete facts, not vague summaries. Don't wait to be asked.",
    promptSnippet: "Save a durable insight about the user to long-term memory",
    promptGuidelines: [
      "Use honcho_save_insight proactively whenever you learn something durable about the user.",
      "Save when the user corrects you, expresses a preference, makes a decision, or reveals a workflow habit.",
      "Write insights as concrete, reusable facts, not vague summaries.",
    ],
    parameters: Type.Object({
      content: Type.String({
        description:
          "The insight to save, written as a concrete, reusable fact. E.g. 'User prefers flat module structures over nested folders' or 'User uses Graphite for git branching, not raw git'.",
      }),
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
