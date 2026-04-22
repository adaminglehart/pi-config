---
name: context-pilot
description: Strategies for proactive context management using context_tag, context_log, and context_checkout. Use for complex tasks, debugging, research, and long conversations.
---

# Context Management

**Your context window is limited. Proactively manage it or lose critical information.**

## Core Philosophy

```
Context Window = RAM  (expensive, volatile, limited)
Session Tree   = Disk (cheap, persistent, unlimited)
→ Move finished work from RAM to Disk.
```

## The Loop: Build → Perceive → Navigate

1. **BUILD** (`context_tag`): Mark milestones to create structure. Without tags, history is a flat list of IDs.
2. **PERCEIVE** (`context_log`): Check the dashboard. Is segment size growing? Are you drifting?
3. **NAVIGATE** (`context_checkout`): Squash noisy history into a clean summary. Jump between tasks.

## Tool Reference

| Tool | Git Analog | When to Use |
|------|-----------|-------------|
| `context_tag` | `git tag` | Before risky changes. At task boundaries. When a feature stabilizes. |
| `context_log` | `git log` | When you feel lost. To find IDs for checkout. To check context health. |
| `context_checkout` | `git reset --soft` | To compress noisy history. To undo mistakes. To switch tasks. |

## Tagging Conventions

**Formula:** `<task-slug>-<phase>`

| Phase | Pattern | Example |
|-------|---------|---------|
| Start | `<task>-start` | `auth-jwt-start` |
| Plan | `<task>-plan` | `api-v2-plan` |
| Milestone | `<task>-<milestone>` | `auth-jwt-impl-done` |
| Backup | `<task>-raw-history` | `auth-jwt-raw-history` |
| Failure | `<task>-fail-<reason>` | `auth-jwt-fail-timeout` |

**Rule:** If you cannot name the tag, you don't know what you're doing. Stop and think.

## Decision Matrix

| Situation | Action |
|-----------|--------|
| Starting a task | `context_tag({ name: "<task>-start" })` |
| Read large files / searched web | Squash immediately — process is noise, only result matters |
| Messy debugging (fixed now) | Squash with backup — error logs are noise once fixed |
| Task complete | Squash with backup — summary is usually enough |
| Goal shift / topic change | Squash — old context is irrelevant |
| Drifting (many steps without tag) | Tag a milestone — maintain the skeleton |
| Failed 3 times | Checkout to last safe tag, summarize failure, try new approach |

## Checkout Messages

Structure: `[Status] + [Reason] + [Changes] + [Next Step]`

**Good:** "Auth module complete: JWT + OAuth2 + RBAC. 23 tests passing. **Reason**: Task done. **Changes**: Created `auth/`, modified `routes.ts`. **Next Step**: Report to user."

**Bad:** "Done." / "Switching context." (You WILL forget why.)

## Recipes

### 1. The Miner (Research → Squash)
Read files, search web, gather info. The *process* is noise — only the *result* matters.
```
context_tag({ name: "research-start" })
// ... read files, search, analyze ...
context_checkout({ target: "research-start", message: "Found X because Y. Changes: none. Next step: implement fix.", backupTag: "research-raw" })
```

### 2. The Candidate (Task Done → Cleanup)
Finished a complex task. History is noisy but result is clean.
```
context_checkout({ target: "<task>-start", message: "Implemented X. Tests pass. Changes: created A, modified B. Next step: report to user.", backupTag: "<task>-raw-history" })
context_tag({ name: "<task>-done" })
```

### 3. The Undo (Failed → Revert)
Tried something, it broke. Go back and try differently.
```
context_checkout({ target: "<task>-start", message: "Approach A failed: <reason>. Changes: modified X (needs revert). Next step: revert X, try approach B.", backupTag: "<task>-fail-a" })
```

## Anti-Patterns

| Don't | Do |
|-------|-----|
| Tag every step | Tag only phase changes (start, milestone, done) |
| Keep all history "just in case" | Squash with backup — you can always checkout the backup |
| Guess IDs for checkout | Run `context_log` first |
| Write vague checkout messages | Include status, reason, changes, and next step |
| Call other tools in same turn as checkout | End your turn after calling `context_checkout` |

## IMPORTANT

- **After checkout**: Read the injected summary. Execute the Next Step from it.
- **Squashing is lossless**: `backupTag` preserves the full history on a side branch.
- **Checkout resets conversation only**: Disk files are NOT changed. Always note file changes in your message.
