---
name: zero-tech-debt
description: Simplifies a change around its intended behavior and removes code that current requirements do not need. Use when asked for "zero tech debt", to "remove compatibility code", or to "rework this change as if it existed from day one". Checks callers, shared rules, and affected behavior.
---

<!--
Inspired by Zero Tech Debt by jnsahaj:
https://github.com/jnsahaj/skills/blob/main/skills/zero-tech-debt/SKILL.md
-->

# Zero Tech Debt

Build the simplest code for the intended result, not for the history of the change.

## Step 1: Define the result and scope

Read the repository instructions and the requested change. State the intended
behavior in one or two sentences. Identify the files and flows in scope.

Keep unrelated changes intact. If the user asks only for a review, report
findings without editing files. Do not use this skill to expand the task into
repository-wide cleanup.

## Step 2: Check current requirements

Inspect callers before you retain or remove a mode flag, wrapper, alias,
fallback, or compatibility path. Use semantic references for code symbols.
Check configuration, tests, public interfaces, and stored data where relevant.

Do not treat the absence of local callers as proof that a public interface is
unused. If an external caller or data migration requirement is not clear,
report the missing evidence and ask before you remove support.

Remove code only when current requirements and caller evidence support removal.
Do not add compatibility code for requirements that no longer exist.

## Step 3: Simplify the change

Choose one clear flow for the intended behavior. Remove unused branches rather
than add more conditions around them. Use names that describe current behavior,
not an earlier implementation.

Keep each shared rule in its existing owner. Check permissions, feature flags,
routes, URL state, and command names for duplicate rules. Do not create a new
abstraction when a direct value or an existing boundary is sufficient.

Split code only at a clear boundary, such as state, layout, or domain behavior.
Prefer the correct final structure over a smaller diff, but change only what
the requested result needs. Do not add a general framework or future features.

## Step 4: Verify affected behavior

Run focused checks for the intended flow and for assumptions removed by the
change. Check navigation, permissions, and stored state when they are affected.
Update tests that enforce behavior the user no longer requires. Keep tests for
behavior that must remain.

Inspect the final diff for unused code, duplicate rules, and unrelated edits.
If a check cannot run, state the limitation. Do not claim that the change removes
all technical debt or that untested behavior works.

## Step 5: Report the result

Report the intended result, removed complexity, checks run, and any open risks.
Support removal decisions with file paths or caller evidence.

Example:

- Result: One save flow uses the current document format.
- Removed: The old-format branch; all save callers use the current format.
- Checks: Save and reload tests passed.
- Open risk: External format support is not confirmed; the public reader is unchanged.

Finish only when the scoped change is verified or the remaining limits are stated.
