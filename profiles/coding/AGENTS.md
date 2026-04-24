# Pi Agent Workflow

## Workflow

For any task that seems complex, modifies more than 4 or 5 files or involves architectural decisions:
1. Ask the user to run `/plannotator plans/<task-name>.md` to enter plan mode (the agent cannot activate this directly)
2. Once in plan mode, explore the codebase and write the plan as markdown checklists
3. Call `exit_plan_mode` to submit for review
4. Wait for approval, then execute — track progress with `[DONE:n]` markers

For simple single-file changes, proceed directly.

## Plan storage

Plans live in the `plans/` directory in the project root, named by feature:
- `plans/auth-refactor.md`
- `plans/api-pagination.md`

**important** don't automatically commit changes to git, ask first or letm e take care of it
  
## Extensions

- if asked to create, edit, or in any way modify a pi extension, do it in the correct pi configuration location under the pi-config repo (which corresponds to ~/.pi). For example, since an extension needs to end up in ~/.pi/agent/extensions, it should go in ~/dev/pi-config/agent/extensions


## Honcho (Long-Term Memory)

Honcho provides persistent memory across sessions. Use it **proactively** — don't wait to be asked.

### `honcho_save_insight` — Save early, save often

Call this whenever you learn something durable about the user. Key moments:
- **User corrects you** — save the correction as a preference/fact so future sessions don't repeat the mistake
- **User expresses a preference** — tool choices, code style, communication style, workflow habits
- **User makes a decision** — architectural choices, technology picks, naming conventions
- **User pushes back** — their objection reveals what they care about
- **You discover a pattern** — after 2+ similar requests, save the pattern

Write insights as concrete, reusable facts:
- ✅ "User prefers flat module structures over nested folders"
- ✅ "User uses Graphite for git branching, not raw git — always use gt create/gt submit"
- ❌ "User has opinions about code organization" (too vague)

### `honcho_chat` — Query before assuming

Call this when you're about to make a choice the user might have an opinion on:
- Choosing between implementation approaches
- Picking defaults, frameworks, or libraries
- Deciding how to structure code or organize files
- Setting up a new project or feature
- Any moment you think "the user might prefer this differently"

## Tool Usage

- Destructive operations (`terraform apply`, `kubectl delete`, etc.) require explicit user approval — see `~/AGENTS.md`
