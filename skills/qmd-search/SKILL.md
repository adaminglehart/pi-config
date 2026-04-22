---
name: qmd-search
description: Search agent learnings and notes using qmd. Use when you need to recall past solutions, patterns, mistakes, or approaches from previous sessions. Combines keyword and semantic search.
triggers:
  - remember
  - past session
  - we did this before
  - learned
  - previous approach
  - how did we
---

# Searching Agent Learnings with qmd

Use `qmd` to search the agent's learning memory stored in Obsidian.

## Commands

Keyword search (fast, exact matches):
```bash
qmd search "your query" --json -c agent-learnings
```

Semantic search (understands meaning, finds related content):
```bash
qmd vsearch "your query" --json -c agent-learnings
```

Hybrid search with reranking (best quality, slower):
```bash
qmd query "your query" --json -c agent-learnings
```

Retrieve a specific file:
```bash
qmd get "daily/2026-03-16.md" -c agent-learnings
```

## When to use

- Before starting a task, check if there are learnings about similar work
- When debugging, search for past fixes to similar issues
- When the user says "we did this before" or "remember when..."
- Prefer `qmd search` for speed, `qmd query` for best results
