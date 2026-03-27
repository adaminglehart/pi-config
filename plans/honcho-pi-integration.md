# Honcho + Pi Integration Plan

## Goal
Give Pi persistent, cross-session memory via a self-hosted Honcho instance. The agent remembers user preferences, project context, and past decisions across sessions — similar to the Claude Code Honcho plugin but built natively as a Pi extension. Personal use only.

## Architecture Overview

```
Pi Session
  ├── session_start → Init Honcho client, load cached context
  ├── before_agent_start → Inject Honcho context into system prompt (every 5 turns + session start)
  ├── agent_end → Save user + assistant text messages to Honcho (no tool results)
  └── session_shutdown → Flush any pending writes
```

**Honcho Data Model Mapping:**
- **Workspace** = `pi` (single global workspace — see rationale below)
- **Peer: user** = `$USER` (the human, `observe_me: true`)
- **Peer: assistant** = `pi` (the AI agent, `observe_me: false`)
- **Session** = mapped per-directory (project path as session ID)

### Workspace Decision: Global vs Per-Project

| Approach | Pros | Cons |
|----------|------|------|
| **Global (1 workspace)** | Cross-project insights (e.g., "user prefers TypeScript"), simpler setup, one config | Project-specific noise in representation |
| **Per-project** | Clean isolation, project-scoped reasoning | No cross-project learning, more overhead to manage |

**Decision: Global workspace.** The main value of Honcho for personal use is building a holistic representation of *you* — your preferences, patterns, and style across all projects. Per-project isolation defeats that purpose. Sessions are already scoped per-directory, which gives project-level conversation boundaries. The workspace-level representation aggregates learning across all of them.

---

## Phase 1: Self-Hosted Honcho in Docker

### Setup
We'll create our own `docker-compose.yml` and `.env` managed directly in `~/dev/pi-config/` rather than cloning the full Honcho repo. We only need the container images.

### Files in `~/dev/pi-config/honcho/`
```
honcho/
├── docker-compose.yml    # Honcho server + deriver + PostgreSQL
├── .env.tmpl             # Chezmoi template pulling API keys
├── .env.template         # Reference template (no secrets)
└── README.md             # Setup instructions
```

### Implementation Details

#### docker-compose.yml

Services needed:
- **database**: `pgvector/pgvector:pg15` — PostgreSQL with vector extension
- **api**: `ghcr.io/plastic-labs/honcho:latest` — Honcho API server (port 8100→8000)
- **deriver**: `ghcr.io/plastic-labs/honcho:latest` with `python -m src.deriver.worker` entrypoint — background worker for reasoning/representations

Redis is NOT required — Honcho falls back to in-memory cache (`mem://`) when `CACHE_ENABLED=false` (which is the default).

```yaml
services:
  database:
    image: pgvector/pgvector:pg15
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: honcho
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - honcho_data:/var/lib/postgresql/data
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d honcho"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    image: ghcr.io/plastic-labs/honcho:latest
    depends_on:
      database:
        condition: service_healthy
    ports:
      - "8100:8000"
    env_file:
      - .env
    restart: unless-stopped

  deriver:
    image: ghcr.io/plastic-labs/honcho:latest
    entrypoint: ["python", "-m", "src.deriver.worker"]
    depends_on:
      database:
        condition: service_healthy
    env_file:
      - .env
    restart: unless-stopped

volumes:
  honcho_data:
```

#### .env.tmpl (chezmoi template)
Key env vars for Honcho server:
```
DB_CONNECTION_URI=postgresql+psycopg://postgres:postgres@database:5432/honcho
AUTH_USE_AUTH=false
ANTHROPIC_API_KEY={{ env "ANTHROPIC_API_KEY" }}
OPENAI_API_KEY={{ env "OPENAI_API_KEY" }}
```

#### .env.template (reference, no secrets)
```
DB_CONNECTION_URI=postgresql+psycopg://postgres:postgres@database:5432/honcho
AUTH_USE_AUTH=false
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

### Chezmoi Integration
- `honcho/.env` is already in `.gitignore` (confirmed)
- The `.env.tmpl` file needs to be registered as a chezmoi template so `chezmoi apply` generates `.env` at `~/.pi/agent/../honcho/.env`
- Actually, honcho/ lives at the pi-config repo root, NOT under `agent/`, so it won't be managed by chezmoi's `agent` chezmoiroot. We need a separate approach.
- **Decision**: Keep `honcho/` at the repo root as a standalone directory. The `.env.tmpl` file gets manually run through `chezmoi execute-template` or we just create `.env` manually since it's a one-time setup. The README documents the setup steps.

### Checklist
- [ ] Create `honcho/docker-compose.yml` with Honcho API + deriver + PostgreSQL
- [ ] Create `honcho/.env.template` as reference
- [ ] Create `honcho/README.md` with setup instructions
- [ ] Add `honcho/.env` to `.gitignore` (already done)
- [ ] Verify: `cd honcho && docker compose up -d && curl http://localhost:8100/docs`

---

## Phase 2: Pi Extension — `honcho/index.ts`

### Location
`~/dev/pi-config/agent/extensions/honcho/index.ts` (directory-based extension with npm deps)

### Package Setup
```
agent/extensions/honcho/
├── index.ts          # Main extension entry point
├── package.json      # SDK dependency
└── package-lock.json # Lock file (after npm install)
```

#### package.json
```json
{
  "name": "pi-honcho",
  "private": true,
  "type": "module",
  "dependencies": {
    "@honcho-ai/core": "^2.2.0"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

**IMPORTANT**: The npm package is `@honcho-ai/core` (NOT `@honcho-ai/sdk`). Latest version: 2.2.0.

### SDK API Reference

The Honcho SDK (`@honcho-ai/core`) is a Stainless-generated client. Key API patterns:

```typescript
import Honcho from "@honcho-ai/core";

const client = new Honcho({ baseURL: "http://localhost:8100/v2", apiKey: "none" });

// Workspace
const workspace = await client.workspaces.getOrCreate({ name: "pi" });

// Peers (nested under workspaces)
const userPeer = await client.workspaces.peers.getOrCreate(workspace.id, "user-peer-id", {
  external_id: "adam",
  name: "adam",
  observe_me: true,  // Honcho reasons about this peer
});
const aiPeer = await client.workspaces.peers.getOrCreate(workspace.id, "ai-peer-id", {
  external_id: "pi",
  name: "pi",
  observe_me: false,  // Don't reason about the AI's behavior
});

// Sessions (nested under workspaces)
const session = await client.workspaces.sessions.getOrCreate(workspace.id, "session-id", {
  external_id: "dev-my-project",  // Sanitized cwd path
  name: "my-project",
});

// Messages (nested under workspaces.sessions)
await client.workspaces.sessions.messages.create(workspace.id, session.id, {
  content: "user message text",
  is_user: true,
});

// Session Context
const context = await client.workspaces.sessions.context(workspace.id, session.id, {
  peer_id: userPeer.id,  // Get context about this peer
});
// Returns: { context: string }

// Peer Chat (natural language query about a peer)
const chatResponse = await client.workspaces.peers.chat(workspace.id, userPeer.id, {
  message: "What are this user's coding preferences?",
  session_id: session.id,
});

// Conclusions (workspace-level insights)
await client.workspaces.conclusions.create(workspace.id, {
  content: "User prefers TypeScript and Go",
  category: "preferences",
});
```

### Pi Extension API Reference

Key APIs we'll use:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

export default function (pi: ExtensionAPI) {
  // Events
  pi.on("session_start", async (_event, ctx) => { ... });
  pi.on("before_agent_start", async (event, ctx) => {
    // Can modify system prompt
    return { systemPrompt: event.systemPrompt + "\n\n## Extra" };
  });
  pi.on("agent_end", async (event, ctx) => {
    // event.messages contains all messages from this prompt
  });
  pi.on("session_shutdown", async (_event, ctx) => { ... });

  // Tools
  pi.registerTool({
    name: "honcho_search",
    label: "Honcho Search",
    description: "...",
    parameters: Type.Object({ query: Type.String() }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: "result" }], details: {} };
    },
  });

  // Commands
  pi.registerCommand("honcho:status", {
    description: "Show Honcho status",
    handler: async (args, ctx) => {
      ctx.ui.notify("Connected!", "info");
    },
  });

  // Status footer
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("honcho", "🧠 Honcho: connected");
  });

  // Inter-extension events
  pi.events.on("my:event", (data) => { ... });
  pi.events.emit("my:event", { ... });
}
```

### Core Behavior

#### 1. Initialization (`session_start`)

```typescript
// State variables (module-level)
let enabled = false;
let client: Honcho;
let workspaceId: string;
let userPeerId: string;
let aiPeerId: string;
let sessionId: string;
let cachedContext: string | null = null;
let turnCounter = 0;
let pendingWrites: Promise<void>[] = [];

pi.on("session_start", async (_event, ctx) => {
  try {
    const baseUrl = process.env.HONCHO_BASE_URL ?? "http://localhost:8100/v2";
    client = new Honcho({ baseURL: baseUrl, apiKey: "none" });

    // Create/get workspace
    const workspace = await client.workspaces.getOrCreate({ name: process.env.HONCHO_WORKSPACE ?? "pi" });
    workspaceId = workspace.id;

    // Create/get peers
    const userName = process.env.HONCHO_PEER_NAME ?? process.env.USER ?? "user";
    const userPeer = await client.workspaces.peers.getOrCreate(workspaceId, userName, {
      external_id: userName,
      name: userName,
      observe_me: true,
    });
    userPeerId = userPeer.id;

    const aiName = process.env.HONCHO_AI_PEER ?? "pi";
    const aiPeer = await client.workspaces.peers.getOrCreate(workspaceId, aiName, {
      external_id: aiName,
      name: aiName,
      observe_me: false,
    });
    aiPeerId = aiPeer.id;

    // Create/get session from cwd
    const sessionExternalId = sanitizePath(ctx.cwd);
    const session = await client.workspaces.sessions.getOrCreate(workspaceId, sessionExternalId, {
      external_id: sessionExternalId,
      name: path.basename(ctx.cwd),
    });
    sessionId = session.id;

    // Fetch initial context
    try {
      const contextResult = await client.workspaces.sessions.context(workspaceId, sessionId, {
        peer_id: userPeerId,
      });
      cachedContext = contextResult.context;
    } catch {
      cachedContext = null;
    }

    enabled = true;
    turnCounter = 0;
    ctx.ui.setStatus("honcho", "🧠 Honcho: connected");
  } catch (err) {
    enabled = false;
    ctx.ui.notify("Honcho: unreachable, memory disabled for this session", "warning");
    ctx.ui.setStatus("honcho", "🧠 Honcho: disconnected");
  }
});
```

Path sanitization helper:
```typescript
function sanitizePath(cwd: string): string {
  // ~/dev/my-project → dev--my-project
  const home = os.homedir();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  return relative.replace(/\//g, "--");
}
```

#### 2. Context Injection (`before_agent_start`)

```typescript
const refreshInterval = parseInt(process.env.HONCHO_REFRESH_INTERVAL ?? "5", 10);

pi.on("before_agent_start", async (event, ctx) => {
  if (!enabled) return;

  turnCounter++;
  const shouldRefresh = turnCounter === 1 || turnCounter % refreshInterval === 0;

  if (shouldRefresh) {
    try {
      const contextResult = await client.workspaces.sessions.context(workspaceId, sessionId, {
        peer_id: userPeerId,
      });
      cachedContext = contextResult.context;
    } catch {
      // Use cached on failure
    }
  }

  if (!cachedContext) return;

  const maxTokens = parseInt(process.env.HONCHO_CONTEXT_TOKENS ?? "2000", 10);
  const truncated = cachedContext.slice(0, maxTokens * 4); // Rough char estimate

  return {
    systemPrompt: event.systemPrompt + `\n\n## User Memory (Honcho)\nThe following is what you know about this user from previous sessions:\n\n${truncated}`,
  };
});
```

#### 3. Message Storage (`agent_end`)

```typescript
pi.on("agent_end", async (event, ctx) => {
  if (!enabled) return;

  // Extract text messages only (skip tool calls, tool results, system)
  for (const msg of event.messages) {
    if (msg.role === "user" && msg.content) {
      const textContent = extractTextContent(msg.content);
      if (textContent) {
        const p = client.workspaces.sessions.messages.create(workspaceId, sessionId, {
          content: textContent,
          is_user: true,
        }).catch(() => {});
        pendingWrites.push(p);
      }
    } else if (msg.role === "assistant" && msg.content) {
      const textContent = extractTextContent(msg.content);
      if (textContent) {
        const p = client.workspaces.sessions.messages.create(workspaceId, sessionId, {
          content: textContent,
          is_user: false,
        }).catch(() => {});
        pendingWrites.push(p);
      }
    }
  }
});

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.filter(c => c.type === "text" && c.text).map(c => c.text!);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}
```

#### 4. Graceful Shutdown (`session_shutdown`)

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  if (!enabled) return;
  await Promise.allSettled(pendingWrites);
  pendingWrites = [];
});
```

### Custom Tools

```typescript
// honcho_search — Semantic search across sessions
pi.registerTool({
  name: "honcho_search",
  label: "Honcho Search",
  description: "Semantic search across all Honcho sessions and messages for the current user",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    if (!enabled) return { content: [{ type: "text", text: "Honcho is not connected" }], details: {} };
    const result = await client.workspaces.peers.chat(workspaceId, userPeerId, {
      message: params.query,
      session_id: sessionId,
    });
    return { content: [{ type: "text", text: result.content }], details: {} };
  },
});

// honcho_chat — Natural language query about the user
pi.registerTool({
  name: "honcho_chat",
  label: "Honcho Chat",
  description: "Ask Honcho about the user — their preferences, patterns, past decisions",
  parameters: Type.Object({
    question: Type.String({ description: "Natural language question about the user" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    if (!enabled) return { content: [{ type: "text", text: "Honcho is not connected" }], details: {} };
    const result = await client.workspaces.peers.chat(workspaceId, userPeerId, {
      message: params.question,
    });
    return { content: [{ type: "text", text: result.content }], details: {} };
  },
});

// honcho_save_insight — Manually save an insight
pi.registerTool({
  name: "honcho_save_insight",
  label: "Honcho Save Insight",
  description: "Save a conclusion/insight about the user to Honcho's long-term memory",
  parameters: Type.Object({
    content: Type.String({ description: "The insight to save" }),
    category: Type.Optional(Type.String({ description: "Category (e.g., preferences, workflow, code-style)" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    if (!enabled) return { content: [{ type: "text", text: "Honcho is not connected" }], details: {} };
    await client.workspaces.conclusions.create(workspaceId, {
      content: params.content,
      category: params.category ?? undefined,
    });
    return { content: [{ type: "text", text: `Saved insight: "${params.content}"` }], details: {} };
  },
});
```

### Slash Commands

```typescript
// /honcho:status — Show connection info
pi.registerCommand("honcho:status", {
  description: "Show Honcho connection status, workspace, session, and peer info",
  handler: async (_args, ctx) => {
    if (!enabled) {
      ctx.ui.notify("🧠 Honcho: disconnected", "warning");
      return;
    }
    const lines = [
      `🧠 Honcho Status`,
      `  Connected: yes`,
      `  Workspace: ${workspaceId}`,
      `  Session: ${sessionId}`,
      `  User Peer: ${userPeerId}`,
      `  AI Peer: ${aiPeerId}`,
      `  Turn: ${turnCounter}`,
      `  Cached context: ${cachedContext ? `${cachedContext.length} chars` : "none"}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  },
});

// /honcho:forget — Clear conclusions (future: selective deletion)
pi.registerCommand("honcho:forget", {
  description: "Show info about clearing Honcho memory (manual via API for now)",
  handler: async (_args, ctx) => {
    ctx.ui.notify(
      "To clear Honcho memory, use the Honcho API directly at http://localhost:8100/docs",
      "info"
    );
  },
});
```

### Configuration

Read from env vars with sensible defaults:
- `HONCHO_BASE_URL` — default `http://localhost:8100/v2`
- `HONCHO_WORKSPACE` — default `pi`
- `HONCHO_PEER_NAME` — default `$USER`
- `HONCHO_AI_PEER` — default `pi`
- `HONCHO_ENABLED` — default `true`
- `HONCHO_CONTEXT_TOKENS` — max tokens for context injection (default `2000`)
- `HONCHO_REFRESH_INTERVAL` — turns between context refreshes (default `5`)

### Error Handling
- If Honcho is unreachable on `session_start`, log a warning via `ctx.ui.notify()` and set `enabled = false`
- Don't block the session or crash if Honcho is down
- Message writes are fire-and-forget with `.catch(() => {})`
- Context refresh failures fall back to cached context silently

### Subagent Memory (Read + Write)

Global extensions auto-load in all Pi processes, including subagents. The Honcho extension works in subagents with no special configuration needed:

- **Reads**: Subagents get user context injected into their system prompt via the same `before_agent_start` hook.
- **Writes**: Subagent conversations are written to Honcho under the same session (same cwd = same session ID).
- **Same session**: Subagents run in the same working directory, so they naturally map to the same Honcho session.

---

## Phase 3: Interview Skill — `/honcho:interview`

The interview is a structured conversation to seed stable, cross-project preferences into Honcho. It runs once (or whenever the user wants to update their profile) and saves conclusions that persist forever.

### What it captures
- **Communication style** — Concise vs detailed, formal vs casual
- **Technical preferences** — Preferred languages, frameworks, patterns
- **Code style** — Comments, testing, abstractions, naming conventions
- **Workflow** — Git workflow, PR style, CI/CD preferences
- **Agent behavior** — When to ask vs proceed, how much context to provide

### Implementation
```typescript
pi.registerCommand("honcho:interview", {
  description: "Structured interview to seed user preferences into Honcho memory",
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

    for (const question of questions) {
      const answer = await ctx.ui.input(question);
      if (!answer) continue;

      await client.workspaces.conclusions.create(workspaceId, {
        content: `Q: ${question}\nA: ${answer}`,
        category: "interview",
      });
    }

    ctx.ui.notify("Interview complete! Preferences saved to Honcho.", "success");
  },
});
```

---

## Phase 4: Polish & UX

### Checklist
- [ ] Startup status in footer: `ctx.ui.setStatus("honcho", "🧠 Honcho: connected")` (done in session_start)
- [ ] Startup notification if Honcho has context for this session: show brief summary
- [ ] Clean error handling — no crashes, no blocking

---

## Phase 5: Advanced Features (Future)

- [ ] **Cross-project memory queries** — Tool to explicitly ask "what do you know about me from other projects?"
- [ ] **Git branch sessions** — `HONCHO_SESSION_STRATEGY=per-git-branch` option
- [ ] **Selective forget** — `/honcho:forget` with actual conclusion deletion via API

---

## Implementation Order & Worker Assignment

### Worker 1: Docker Infrastructure (Phase 1)
**Files to create:**
- `honcho/docker-compose.yml`
- `honcho/.env.template`
- `honcho/README.md`

No code dependencies on other workers.

### Worker 2: Pi Extension Core (Phase 2)
**Files to create:**
- `agent/extensions/honcho/package.json`
- `agent/extensions/honcho/index.ts`

Must run `npm install` in `agent/extensions/honcho/` after creating `package.json`.

This is the main implementation — includes:
- Initialization (session_start)
- Context injection (before_agent_start)
- Message storage (agent_end)
- Shutdown (session_shutdown)
- All 3 custom tools (honcho_search, honcho_chat, honcho_save_insight)
- All slash commands (honcho:status, honcho:interview, honcho:forget)
- Footer status
- Error handling
- Configuration via env vars
