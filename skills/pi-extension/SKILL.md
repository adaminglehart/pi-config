---
name: pi-extension
description: Create Pi extensions with custom tools, commands, and event handlers. Use when asked to "create a pi extension", "write an extension", "add a custom tool", "register a command", or "extend pi". Provides templates and explains the ExtensionAPI.
---

# Create Pi Extensions

Guide for creating Pi extensions that add custom tools, commands, and event handlers.

## Step 1: Extension Structure

Pi discovers extensions from:
- `~/.pi/agent/extensions/*.ts` — single-file extensions
- `~/.pi/agent/extensions/*/index.ts` — directory-based extensions

**Module isolation:** Each extension directory is an isolated module. Extensions in separate directories **cannot import from each other**. Extensions in the same directory tree **can** share imports via relative paths.

## Step 2: Basic Template

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Event handler
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  // Custom tool
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does",
    parameters: Type.Object({ name: Type.String() }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: "Result" }] };
    },
  });

  // Custom command
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args}!`, "info");
    },
  });
}
```

## Step 3: Choose Extension Style

| Style | Structure | Use When |
|-------|-----------|----------|
| **Single file** | `my-ext.ts` | Simple extensions, no dependencies |
| **Directory** | `my-ext/index.ts` | Needs npm dependencies or multiple files |
| **With package.json** | `my-ext/package.json` + `index.ts` | Complex dependencies, own node_modules |

For directory-based extensions with dependencies:

```json
{
  "name": "my-extension",
  "dependencies": { "some-lib": "^1.0.0" }
}
```

Run `npm install` in the extension directory. Pi uses jiti to load TypeScript without compilation.

## Step 4: APIs and Patterns

### Events

Read `~/.local/share/mise/installs/node/.../pi-coding-agent/docs/extensions.md` for the full event reference including:
- `tool_call` — intercept and block tools
- `tool_result` — modify tool results  
- `input` — transform user input
- `before_agent_start` — inject context
- Session lifecycle events

### Custom Tools

Key patterns from the docs:
- Throw errors to mark tool as failed (`isError: true`)
- Use `promptSnippet` to include tool in system prompt
- Use `withFileMutationQueue()` for file edits to avoid race conditions
- Truncate output to 50KB/2000 lines

### UI Methods

Available via `ctx.ui`:
- `notify()`, `confirm()`, `select()`, `input()`, `editor()`
- `setStatus()`, `setWidget()` for persistent UI
- `custom()` for full TUI components

See `docs/tui.md` for the full UI component API.

### State Management

Store state in tool result `details` and reconstruct from `ctx.sessionManager.getBranch()` on `session_start`.

## Step 5: Test and Reload

After changes, run:

```
/reload
```

Check output for syntax errors, import failures, or runtime errors.

## Important Constraints

- **No auto-install:** Run `npm install` yourself in extension directories
- **No cross-extension imports:** Extensions are isolated; use shared config files instead
- **File mutations:** Use `withFileMutationQueue()` to prevent race conditions

## Resources

- **Full docs:** `~/.local/share/mise/installs/node/.../pi-coding-agent/docs/extensions.md`
- **Examples:** `~/.local/share/mise/installs/node/.../pi-coding-agent/examples/extensions/`
- **TUI docs:** `docs/tui.md` for custom components
