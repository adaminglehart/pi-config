# Pi Agent Workflow

## Workflow

For any task that modifies more than 2 files or involves architectural decisions:
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

## Context Management

Always use the context-pilot skill for proactive context management. Read the skill file at the start of every session and follow its guidelines throughout.

## Tool usage

- NEVER run a terraform apply or other possibly destructive command without asking for confirmation first
