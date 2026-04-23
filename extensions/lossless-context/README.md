# Lossless Context Management Extension

A Pi extension that replaces the default sliding-window compaction with a **DAG-based summarization system**. Every message is persisted to SQLite and organized into a hierarchy of summaries. The agent can drill into any summary to recover the original detail — nothing is ever truly lost.

Adapted from [lossless-claw](https://github.com/martian-engineering/lossless-claw) (LCM plugin for OpenClaw).

## How it works

1. **Every message is persisted** to a SQLite database on each `message_end` event
2. **When context grows too large**, the compaction engine summarizes older messages into leaf summaries, then condenses those into higher-level summaries — forming a DAG (directed acyclic graph)
3. **Before each LLM call**, the context assembler replaces Pi's default message array with a budget-aware mix of summaries + the fresh tail of recent raw messages
4. **The agent gets retrieval tools** (`lcm_grep`, `lcm_expand`, etc.) to search and drill back into any compacted history

Pi's default compaction is cancelled — LCM handles everything.

## Architecture

```
index.ts (entry point)
├── Events: session_start, message_end, turn_end, context,
│           session_before_compact, tool_result, session_shutdown
├── Tools: lcm_grep, lcm_describe, lcm_expand, lcm_expand_query
└── Commands: /lcm, /lcm backup, /lcm doctor, /lcm rotate

src/
├── Core
│   ├── assembler.ts          Context assembly (summaries + messages → LLM context)
│   ├── compaction.ts         Leaf passes, condensed passes, threshold triggers
│   ├── summarize.ts          LLM calls for summarization
│   ├── summarize-prompts.ts  Depth-aware prompt templates
│   ├── serialize-messages.ts Message serialization for summarization
│   ├── retrieval.ts          Retrieval engine (grep, describe, expand)
│   ├── large-files.ts        Large tool output interception and storage
│   ├── integrity.ts          DAG integrity checking and repair
│   └── commands.ts           /lcm command implementations
│
├── Database
│   ├── db/connection.ts      SQLite connection (node:sqlite, WAL mode, FTS5)
│   └── db/migration.ts       Schema: conversations, messages, summaries, DAG tables
│
├── Stores
│   ├── store/conversation-store.ts  Message CRUD, FTS5 search
│   ├── store/summary-store.ts       Summary DAG persistence
│   ├── store/context-items-store.ts Ordered context item management
│   └── store/fts5-sanitize.ts       FTS5 query sanitization
│
├── Tools
│   ├── tools/lcm-grep.ts           Search all history
│   ├── tools/lcm-describe.ts       Inspect summary metadata and lineage
│   ├── tools/lcm-expand.ts         Drill into summaries → raw messages
│   └── tools/lcm-expand-query.ts   Ask questions about old context (LLM-powered)
│
├── Utilities
│   ├── config.ts             Settings from Pi's settings.json (lcm namespace)
│   ├── types.ts              All TypeScript type definitions
│   ├── tokens.ts             Token estimation (chars / 3.5)
│   ├── session-key.ts        cwd → session key mapping
│   ├── message-utils.ts      Extract text from Pi's message formats
│   └── message-format.ts     Convert DB records ↔ Pi-compatible messages
```

## Data flow

### Per-message persistence
```
message_end event
  → extractTextContent(message)
  → computeIdentityHash(role, content)
  → estimateTokens(content)
  → conversationStore.addMessage()  // also creates context_item + FTS5 index
```

### Compaction (after each turn)
```
turn_end event
  → shouldCompact(conversationId, tokenBudget)?
  → Leaf pass:
      Group evictable messages into ~leafChunkTokens chunks
      For each chunk: serialize → LLM summarize → create leaf summary
      Replace context_items: remove message refs, add summary ref
  → Condensed pass (if incrementalMaxDepth >= 1):
      Group same-depth summaries meeting condensedMinFanout
      Serialize → LLM summarize → create condensed summary at depth+1
      Replace context_items
```

### Context assembly (before each LLM call)
```
context event
  → Get all context_items ordered by ordinal
  → Resolve each → message record or summary record
  → Split: evictable prefix | protected fresh tail (last N messages)
  → Budget-aware selection: add evictable items newest-first until budget
  → Group consecutive summaries into single injection messages
  → Return assembled messages[]
```

## DAG structure

```
Raw Messages:  m1  m2  m3  m4  m5  m6  m7  m8  m9  m10 ...
                └───┬───┘   └───┬───┘   └───┬───┘
Leaf (d=0):     leaf_a       leaf_b       leaf_c        (fresh tail)
                 └─────────┬──────────┘
Condensed (d=1):      condensed_x
```

- **Leaf summaries** (depth 0) → link to source messages via `summary_messages`
- **Condensed summaries** (depth 1+) → link to parent summaries via `summary_parents`
- **context_items** tracks the current "active" set (mix of summaries + raw messages)

## Configuration

All settings live under the `lcm` namespace in Pi's `settings.json`:

```json
{
  "lcm": {
    "enabled": true,
    "dbPath": "~/.pi/lcm.db",
    "summaryProvider": "openrouter",
    "summaryModel": "google/gemini-3-flash-preview",
    "contextThreshold": 0.75,
    "freshTailCount": 64,
    "leafChunkTokens": 20000,
    "leafMinFanout": 8,
    "condensedMinFanout": 4,
    "incrementalMaxDepth": 1,
    "leafTargetTokens": 2400,
    "condensedTargetTokens": 2000,
    "maxExpandTokens": 4000,
    "largeFileTokenThreshold": 25000,
    "summaryTimeoutMs": 60000
  }
}
```

Defaults are used when settings are omitted. Uses the same `getNamespacedConfig` pattern as other Pi extensions.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable/disable the extension |
| `dbPath` | `~/.pi/lcm.db` | SQLite database path |
| `summaryProvider` | `openrouter` | LLM provider for summarization |
| `summaryModel` | `google/gemini-3-flash-preview` | LLM model for summarization |
| `contextThreshold` | `0.75` | Fraction of context window that triggers compaction |
| `freshTailCount` | `64` | Recent messages always protected from compaction |
| `leafChunkTokens` | `20000` | Max tokens per leaf compaction chunk |
| `leafMinFanout` | `8` | Min messages required to create a leaf summary |
| `condensedMinFanout` | `4` | Min summaries required for condensation |
| `incrementalMaxDepth` | `1` | How deep condensed passes go (0=leaf only, -1=unlimited) |
| `maxExpandTokens` | `4000` | Token cap for lcm_expand results |
| `largeFileTokenThreshold` | `25000` | Tool outputs above this are externalized |

## Tools

| Tool | Purpose |
|------|---------|
| `lcm_grep` | Search all history (messages + summaries) by keyword |
| `lcm_describe` | Inspect a summary's metadata, DAG lineage, and content |
| `lcm_expand` | Drill into a summary to recover source messages or child summaries |
| `lcm_expand_query` | Ask a natural language question about old context (LLM-synthesized answer) |

## Commands

| Command | Description |
|---------|-------------|
| `/lcm` | Status overview (DB info, counts, config) |
| `/lcm backup` | Create timestamped SQLite backup via VACUUM INTO |
| `/lcm doctor` | Check DAG integrity, report issues |
| `/lcm doctor fix` | Check and auto-repair DAG issues |
| `/lcm rotate` | Force-compact all remaining raw messages |

## Database

Uses **`node:sqlite`** (built-in to Node.js 22+) with:
- WAL mode for concurrency
- FTS5 for full-text search (with LIKE fallback)
- Foreign key relationships between all tables

### Tables
- `conversations` — session-to-conversation mapping
- `messages` — all raw messages with role, content, tokens, identity hash
- `summaries` — leaf and condensed summaries with depth and metadata
- `summary_messages` — leaf → source messages (DAG edges)
- `summary_parents` — condensed → child summaries (DAG edges)
- `context_items` — ordered "active" context (pointers to messages or summaries)
- `large_files` — externalized large tool outputs
- `messages_fts` / `summaries_fts` — FTS5 virtual tables

## Dependencies

No npm dependencies required. Uses:
- `node:sqlite` (built-in) — SQLite database
- `node:crypto` — UUID generation and hashing
- `node:fs` / `node:path` / `node:os` — file operations
- `@mariozechner/pi-ai` — `completeSimple` for LLM summarization calls
- `@mariozechner/pi-coding-agent` — Pi extension API
- `typebox` — tool parameter schemas

## Adapted from lossless-claw

Key differences from the original OpenClaw plugin:
- **Event-driven** — uses Pi's extension events instead of OpenClaw's ContextEngine interface
- **Simplified expansion** — `lcm_expand_query` does direct LLM calls instead of sub-agent delegation via gateway RPC
- **No native deps** — uses `node:sqlite` instead of `better-sqlite3`
- **Modular files** — no file exceeds ~460 lines (vs 6500-line engine.ts in lossless-claw)
- **Settings via Pi** — uses Pi's `settings.json` instead of environment variables
