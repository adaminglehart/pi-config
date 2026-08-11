---
name: pi-extension
description: Create Pi extensions with custom tools, commands, and event handlers. Use when asked to "create a pi extension", "write an extension", "add a custom tool", "register a command", or "extend pi". Covers the pi-config source workflow, the ExtensionAPI, and templates.
---

# Create Pi Extensions

Guide for creating Pi extensions that add custom tools, commands, and event handlers.

## Step 0: Find the real docs first

`docs/extensions.md` is ~3000 lines and is the authoritative reference. Resolve
it before you guess at an API:

```bash
PI_ROOT="$(dirname "$(readlink -f "$(command -v pi)")")/.."
ls "$PI_ROOT/docs"            # extensions.md, tui.md, skills.md, settings.md, ...
ls "$PI_ROOT/examples/extensions"
```

The main agent's system prompt also lists these resolved paths under
"Pi documentation". Use them when present.

Read `reference.md` next to this file for the API surface map, then open the
relevant `docs/` section.

## Step 1: Edit the source repo, never `~/.pi/agent`

`~/dev/pi-config` is the source of truth. `~/.pi/agent/extensions/` is
**generated output** — edits there are erased by the next deploy.

| Purpose | Path |
|---|---|
| Single-file extension | `~/dev/pi-config/extensions/<name>.ts` |
| Directory extension | `~/dev/pi-config/extensions/<name>/index.ts` |
| Shared code between extensions | `~/dev/pi-config/shared/lib/` |
| Allowlist that decides deployment | `~/dev/pi-config/pi.jsonc` |

## Step 2: Basic template

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

## Step 3: Choose extension style

| Style | Structure | Use when |
|-------|-----------|----------|
| **Single file** | `<name>.ts` | Simple logic, no dependencies |
| **Directory** | `<name>/index.ts` | Multiple files |
| **Directory + package.json** | `<name>/package.json` + `index.ts` | Needs npm dependencies |
| **Directory + config.json** | `<name>/config.json` | The extension reads its own settings file, like `extensions/subagent/config.json` |

### Module isolation

Extensions in separate directories **cannot** import from each other.
Extensions in the same directory tree **can** share imports via relative paths.

For code shared across extensions, put it in `shared/lib/`. The build stages
that directory as `extensions/_lib/` in the deployed output.

## Step 4: Dependencies use pnpm only

Do not use npm, yarn, or `bun install`. Do not create their lockfiles.

Each extension with a `package.json` is a standalone pnpm project with a
committed `pnpm-lock.yaml` and `pnpm-workspace.yaml`.

`<name>/pnpm-workspace.yaml` must contain:

```yaml
nodeLinker: hoisted
dangerouslyAllowAllBuilds: true
```

Then:

```bash
cd ~/dev/pi-config/extensions/<name>
pnpm install          # commit the resulting pnpm-lock.yaml
```

Install the **latest** version of a dependency unless an older one is required.

The deploy hook `agent/run_after_install_extension_deps.sh` runs `pnpm install`
for every deployed extension package, so you do not install into `~/.pi/agent`
by hand.

## Step 5: Register in `pi.jsonc`

**An extension that is not in the allowlist is never deployed.** This is the
most common reason a new extension appears to do nothing.

```jsonc
{
  "pi": {
    "extensions": [
      // ...
      "my-extension"   // directory name, or file name without .ts
    ]
  }
}
```

## Step 6: Deploy, reload, verify

```bash
cd ~/dev/pi-config && just apply
```

Then run `/reload` in the session and check the output for syntax errors, import
failures, and runtime errors.

`/reload` reads the **deployed** copy, so `just apply` must run first. Editing
the source and running `/reload` alone changes nothing.

Typecheck before you claim it works:

```bash
cd ~/dev/pi-config/extensions && bunx tsc --noEmit
```

## Key APIs and patterns

### Events

`tool_call` (intercept and block tools), `tool_result` (modify results), `input`
(transform user input), `before_agent_start` (inject context), plus the session
lifecycle events. Full reference: `docs/extensions.md` → "Events".

### Custom tools

- Throw an error to mark the tool failed (`isError: true`).
- Use `promptSnippet` to give the tool a one-line entry in the system prompt.
  Without a snippet the tool does not appear in "Available tools".
- Use `withFileMutationQueue()` for file edits to avoid race conditions.
- Truncate output to 50KB / 2000 lines.
- `pi.registerTool()` works during load **and** after startup — inside
  `session_start`, command handlers, or other event handlers. New tools refresh
  immediately, with no `/reload`.

### UI methods

Via `ctx.ui`: `notify()`, `confirm()`, `select()`, `input()`, `editor()`,
`setStatus()`, `setWidget()` for persistent UI, and `custom()` for full TUI
components. See `docs/tui.md`.

### Self-invoking a command

There is no agent-callable tool for running slash commands. An extension can
queue one:

```typescript
pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
```

Use `pi.getCommands()` to see what is invocable, and `pi.getAllTools()` to see
registered tools.

### State management

Store state in a tool result's `details`, then reconstruct it from
`ctx.sessionManager.getBranch()` on `session_start`.

## Constraints

- **Never edit `~/.pi/agent/extensions/`** — it is generated.
- **pnpm only** — no npm, yarn, or bun lockfiles.
- **No cross-extension imports** — use `shared/lib/` for shared code.
- **File mutations** — use `withFileMutationQueue()` to prevent races.
- **Allowlist required** — add the name to `pi.jsonc` or it will not deploy.
