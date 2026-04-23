---
name: knowledge-graph
description: Maintain an organic personal memory garden in Obsidian. Capture durable context as natural notes, connect related ideas with links, and use QMD retrieval to recall what matters later.
triggers:
  - remember that
  - we decided
  - my preference
  - learned that
  - important point
  - key insight
  - about me
  - note this
  - save this
---

# Knowledge Graph Behavior

You maintain a personal memory garden in Obsidian. The goal is not to force everything into a rigid ontology. The goal is to preserve information that will likely matter later, in a form that still feels natural and readable.

## Core Model

The primitive is a **memory note**.

A memory note is:
- a human-readable markdown note
- optionally given a soft `kind`
- optionally tagged
- linked to nearby notes when useful
- indexed in QMD for retrieval

Prefer natural notes over elaborate schemas.

## What Is Worth Capturing

Capture information that is likely to help in future conversations, recommendations, or follow-up work:

- durable preferences and habits
- decisions and the reasons behind them
- important people, projects, and recurring threads
- useful research findings and references
- constraints, goals, and context that keep coming up
- open questions worth revisiting later

Usually skip:
- trivial chatter
- one-off incidental details
- redundant restatements of existing memory
- sensitive information unless clearly appropriate and useful

## Capture Style

When storing something, optimize for future readability:

- write in natural prose
- include enough context that it still makes sense later
- use a soft `kind` only when it adds value
- add a few tags only when they help retrieval
- prefer links over duplication when a related note already exists

Good note shapes:
- a short statement of the preference or fact
- a decision note with brief rationale
- a project note with current status and open loops
- a research note with findings, implications, and next questions

## Default Workflow

### During conversation
1. Notice memory-worthy information
2. Decide whether it is durable enough to keep
3. Search first if you suspect a note already exists
4. Update the existing note if appropriate
5. Otherwise create a new memory note
6. Link related notes when the relationship is obvious

### Before making recommendations
Check for:
- user preferences
- prior decisions
- active projects or constraints
- relevant past research

Use `kg-query` first when the question is fuzzy, `kg-search` for exact terms, and `kg-semantic-search` when the wording may differ.

## Primary Tools

### `kg-capture-memory`
Default write tool. Use this for most new memory capture.

Best for:
- preferences
- project notes
- decision summaries
- research findings
- important contextual facts

Recommended style:
- `title`: short and readable
- `content`: a few sentences or bullet points with context
- `kind`: optional soft label such as `preference`, `project`, `decision`, `research`, `person`, `idea`
- `tags`: a small set only if helpful
- `links`: only when you already know adjacent notes

### `kg-update-node`
Use when the memory already exists and should be extended rather than duplicated.

Good uses:
- append a new development
- refine a preference
- record changed circumstances
- add links to adjacent notes

### `kg-add-edge`
Use when two notes should be explicitly linked and the connection is worth preserving.

Do not over-link everything. Use links when they improve navigation or future recall.

## Retrieval Tools

### `kg-query`
Best-quality search.
Use for natural language questions such as:
- "What have we decided about local AI model deployment?"
- "What do I usually prefer for git workflows?"
- "What context do we already have about this project?"

### `kg-search`
Fast keyword lookup.
Use for names, exact phrases, filenames, and direct term matching.

### `kg-semantic-search`
Use when you know the idea but not the exact vocabulary.

### `kg-get-node`
Use when you want a specific note by title, filename, or path.

### `kg-related` / `kg-get-path`
Use to navigate the graph after notes exist.

## How to Decide Between Honcho and the Memory Garden

Use **Honcho** for:
- short durable user insights
- preferences and workflow facts that should be immediately reusable across sessions
- concise memory snippets

Use the **memory garden** for:
- richer notes that benefit from prose
- evolving topics
- linked context
- research and project threads
- decisions with rationale

Often both are appropriate:
- save a concise distilled insight to Honcho
- keep the richer surrounding context in Obsidian

## Good Patterns

### Preference
- Title: `Graphite git workflow preference`
- Kind: `preference`
- Content: what the preference is, why it matters, and any relevant examples

### Decision
- Title: `Use organic memory notes instead of rigid entities`
- Kind: `decision`
- Content: what was chosen, why, and what should change as a result

### Project / thread
- Title: `Personal memory garden design`
- Kind: `project`
- Content: current direction, open questions, related systems, next steps

### Research note
- Title: `QMD retrieval patterns for personal memory`
- Kind: `research`
- Content: findings, implications, and uncertainty if relevant

## Quality Bar

Before storing something, ask:
- Will this probably matter again?
- Will future me understand this without today's transcript?
- Should this update an existing note instead of creating a new one?
- Is there an obvious related note worth linking?
- Am I avoiding unnecessary sensitive detail?

## Important Principle

The graph should feel like a **garden of useful notes**, not a CRM or ontology project.

Structure should emerge from:
- note titles
- light metadata
- links
- tags
- QMD retrieval

If forced classification would make the note worse, skip it and write the natural note instead.
