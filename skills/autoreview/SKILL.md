---
name: autoreview
description: Opt-in Codex-backed structured git diff review. Use only when the user explicitly invokes /skill:autoreview for a closeout review before commit, PR, or ship.
compatibility: Requires git, Python 3, and an authenticated Codex CLI on PATH.
license: MIT; adapted from openclaw/agent-skills.
disable-model-invocation: true
---

<!--
Adapted from OpenClaw Agent Skills autoreview:
https://github.com/openclaw/agent-skills/tree/main/skills/autoreview
-->

# Auto Review

Run the bundled Codex-backed structured review helper as an explicit closeout check. This skill is opt-in only; do not use it unless the user invoked `/skill:autoreview` or explicitly asked to run this skill.

The helper builds one frozen git change bundle, sends it to external `codex exec`, validates one structured JSON result, prints a human report, and exits nonzero when actionable findings remain.

## Step 1: Resolve the Helper

Resolve `scripts/autoreview` relative to this skill directory before running it. In a deployed coding profile, the path is usually:

```bash
~/.pi/agent/skills/autoreview/scripts/autoreview
```

Use the absolute path in `bash` commands. Run commands from the repository being reviewed, not from the skill directory.

## Step 2: Pick the Review Target

Choose the narrowest target that matches the user's request.

| Situation | Command |
|---|---|
| Staged, unstaged, or untracked local changes | `<helper> --mode local` |
| Current branch / PR against main | `<helper> --mode branch --base origin/main` |
| Current branch / PR with known base | `<helper> --mode branch --base origin/<base>` |
| One committed change | `<helper> --mode commit --commit HEAD` |

If an open GitHub PR exists and `gh` is available, prefer the real PR base:

```bash
base=$(gh pr view --json baseRefName --jq .baseRefName)
<helper> --mode branch --base "origin/$base"
```

Use `--mode auto` only when the intended target is obvious: it reviews dirty local changes first, otherwise a non-`main` branch against the detected PR base or `origin/main`.

## Step 3: Run Codex Review

Basic branch review:

```bash
<helper> --mode branch --base origin/main
```

Review with extra context:

```bash
<helper> --mode branch --base origin/main \
  --prompt-file /tmp/review-notes.md \
  --dataset /tmp/evidence.json
```

Review and focused tests in parallel:

```bash
<helper> --mode branch --base origin/main \
  --parallel-tests "<focused test command>"
```

Useful options:

- `--model <model>` — pass a Codex model override.
- `--thinking low|medium|high|xhigh` — pass Codex reasoning effort.
- `--no-web-search` — disable Codex web search.
- `--stream-engine-output` — show compact live Codex progress while preserving structured validation.
- `--json-output <file>` — write the validated structured JSON report.
- `--output <file>` — tee the human report to a file.
- `--dry-run` — show target/config without calling Codex.

## Step 4: Handle Findings

Treat review output as advisory.

1. Verify every finding by reading the real code path and adjacent files.
2. Reject speculative risks, unrealistic edge cases, broad rewrites, and fixes that over-complicate the codebase.
3. Prefer small fixes at the right ownership boundary.
4. If an accepted finding reveals a repeated bug class in the reviewed scope, inspect sibling instances before fixing.
5. If a review-triggered fix changes code, rerun focused tests and rerun the helper.
6. Stop once the helper exits 0 with no accepted/actionable findings.

Do not run an extra review solely for nicer wording or a second opinion after a clean helper run.

## Long-Running Reviews

Large reviews can run for a long time. Treat heartbeat lines like this as healthy progress:

```text
review still running: codex elapsed=...s pid=...
```

Do not kill the helper just because it is quiet for a few minutes. Inspect only after missing multiple expected heartbeats, after roughly 30 minutes, or after an obviously failed subprocess.

## Final Report

Report:

- exact review command used
- tests/proof run
- findings accepted and rejected, with brief reasons
- final clean review result, or why a remaining finding was consciously rejected
