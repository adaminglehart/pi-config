# Pi ExtensionAPI reference map

Resolve the authoritative docs before relying on anything here:

```bash
PI_ROOT="$(dirname "$(readlink -f "$(command -v pi)")")/.."
$PI_ROOT/docs/extensions.md      # ~3000 lines, the full reference
$PI_ROOT/docs/tui.md             # custom UI components
$PI_ROOT/docs/settings.md        # settings.json schema
$PI_ROOT/docs/skills.md          # skill frontmatter and discovery
$PI_ROOT/docs/prompt-templates.md
$PI_ROOT/docs/packages.md        # npm/git package extensions
$PI_ROOT/examples/extensions/    # working examples
```

## `ExtensionAPI` methods

| Method | Use |
|---|---|
| `pi.on(event, handler)` | Subscribe to a lifecycle event |
| `pi.registerTool(definition)` | Add an LLM-callable tool; works at load time and after startup |
| `pi.registerCommand(name, options)` | Add a slash command |
| `pi.getCommands()` | List invocable commands, prompt templates, and skill commands |
| `pi.sendMessage(message, options?)` | Inject an assistant-visible message |
| `pi.sendUserMessage(content, options?)` | Queue user input, including a slash command; `{ deliverAs: "followUp" }` |
| `pi.appendEntry(customType, data?)` | Write a custom session entry |
| `pi.setSessionName(name)` / `pi.getSessionName()` | Session title |
| `pi.setLabel(entryId, label)` | Label a session entry |
| `pi.registerMessageRenderer(customType, renderer)` | Render a custom message type |
| `pi.registerEntryRenderer(customType, renderer)` | Render a custom entry type |
| `pi.registerMarkdownTransformer(transformer)` | Rewrite markdown before display |
| `pi.registerShortcut(shortcut, options)` | Bind a key |
| `pi.registerFlag(name, options)` | Add a CLI flag |
| `pi.exec(command, args, options?)` | Run a subprocess |
| `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools(names)` | Tool gating |
| `pi.setModel(model)` | Switch model |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)` | Thinking level |
| `pi.registerProvider(name, config)` / `pi.unregisterProvider(name)` | Custom providers |
| `pi.events` | Event emitter handle |

## Event lifecycle

Startup:

```
project_trust  →  session_start { reason: "startup" }  →  resources_discover
```

Per prompt:

```
(extension commands checked first, and bypass the rest if matched)
input                      can intercept, transform, or handle
(skill / template expansion if not handled)
before_agent_start         can inject a message or modify the system prompt
agent_start
message_start / message_update / message_end
  turn_start
  context                  can modify messages
  before_provider_headers  can mutate headers
  before_provider_request  can inspect or replace the payload
  after_provider_response  status + headers, before the stream is consumed
    tool_execution_start
    tool_call              can block
    tool_execution_update
    tool_result            can modify
    tool_execution_end
  turn_end
agent_end
agent_settled              no retry, compaction, or follow-up left
```

Session transitions:

| Trigger | Events |
|---|---|
| `/new`, `/resume` | `session_before_switch` (cancellable) → `session_shutdown` → `session_start` → `resources_discover` |
| `/fork`, `/clone` | `session_before_fork` (cancellable) → `session_shutdown` → `session_start { reason: "fork" }` → `resources_discover` |
| `/name` | `session_info_changed` |
| `/compact` or auto | `session_before_compact` (cancellable) → `session_compact` |
| `/tree` | `session_before_tree` (cancellable) → `session_tree` |
| `/model`, `Ctrl+P` | `thinking_level_select` |

## Custom tool result shape

```typescript
{
  content: [{ type: "text", text: "..." }],
  details?: unknown,     // persisted in the session; use for state
  isError?: boolean,     // or just throw
}
```

- Throw to mark the tool failed.
- `promptSnippet` gives the tool a one-line entry in the system prompt. Without
  it, the tool is not listed under "Available tools".
- `withFileMutationQueue()` serializes file edits.
- Truncate output to 50KB / 2000 lines.

## System prompt assembly

`buildSystemPrompt()` concatenates, in order:

1. the base prompt (or `SYSTEM.md` when it replaces the default)
2. `APPEND_SYSTEM.md`, if present
3. `<project_context>` with each loaded `AGENTS.md` / `CLAUDE.md`
4. the skills section, only when the `read` tool is active
5. `Current working directory: <cwd>`

Context files load from `~/.pi/agent/AGENTS.md`, then every directory from the
filesystem root down to the cwd. `AGENTS.override.md` replaces `AGENTS.md` for
its own directory. `--no-context-files` / `-nc` disables discovery, but does not
disable `APPEND_SYSTEM.md`.
