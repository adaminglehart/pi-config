# AGENTS.md

## Repository model

`~/dev/pi-config` is the source of truth for one primary Pi agent. The primary
manifest is `pi.jsonc`; primary runtime sources are in `agent/`; and generated
output is `build/agent/`. The manifest declares the deployment destination,
currently `~/.pi/agent`, and the enabled extension and skill allowlists.

`profiles/personal/` is deferred migration input. Leave it untouched: it is
not an active profile and is not read by the primary build or deployment
pipeline.

Do not edit `~/.pi/agent` directly when it is managed by this repository. Edit
source files, build, then use the Justfile deploy flow when deployment is
requested.

After making changes in this repository, always run `just apply` so the
primary agent is rebuilt and deployed. Do not leave changes unapplied unless explicitly told to.

Unless explicitly told otherwise, make changes directly on `main`. Do not
create or push feature branches for repository changes unless explicitly requested.

## Source and generated locations

Authoritative source:

- `pi.jsonc` — primary destination plus extension/skill selection
- `agent/` — `AGENTS.md`, `APPEND_SYSTEM.md`, agent definitions, deploy hook
- `extensions/` and `skills/` — shared selectable components
- `config/` — base and environment-specific generated config layers
- `shared/lib/` — code staged to `extensions/_lib/`
- `build.ts`, `scripts/`, and `Justfile` — build and deployment pipeline

Generated or deployed output:

- `build/agent/`
- `~/.pi/agent` (or the root manifest's `pi.destDir`)

Never hand-edit generated output. Do not delete unfamiliar ignored/runtime
contents from `agent/`; the primary builder deliberately excludes its runtime
`extensions/`, `skills/`, and `node_modules` directories.

## Build behavior

`build.ts` has no profile argument. It:

- reads root `pi.jsonc`
- detects `home` on `MacBook-Pro.local` and `work` otherwise (override with
  `PI_BUILD_ENV`)
- copies only manifest-selected extensions and skills to `build/agent/`
- stages `shared/lib/` as `extensions/_lib/` and root extension development
  tooling (`package.json`, `tsconfig.json`)
- copies primary files from `agent/`, excluding runtime dependency directories
- merges and writes `settings.json`, `models.json`, and `mcp.json`
- resolves `${ENV_VAR}` values and model-alias placeholders
- stages environment-specific `fnox.toml` when present
- removes stale deployed agents, extensions, and skills before deployment

Generated config uses only these layers, with later layers overriding earlier
ones:

1. `config/<name>.base.json(.c)`
2. `config/<env>/<name>.json(.c)`
3. `config/<env>/<name>.local.json(.c)`

`*.local.json` and `*.local.jsonc` are gitignored machine-specific overrides.
Missing `${ENV_VAR}` values fail the build.

## Commands

```bash
just build              # Generate build/agent/
just deploy             # Build and deploy the primary agent
just apply              # Equivalent build-and-deploy command
just diff               # Inspect build/agent/ against its destination
just clean              # Remove generated output and managed deployed files
just honcho-env         # Generate honcho/.env for the active environment
```

The deploy flow uses `scripts/dest.ts` to read root `pi.jsonc`, rsyncs
`build/agent/` excluding `node_modules`, and runs
`agent/run_after_install_extension_deps.sh`. The hook locates `extensions/`
relative to its deployed location and runs `pnpm install` in every extension
with a `package.json`.

## Extension dependencies

All npm package management uses **pnpm**. Do not introduce npm, Bun install,
yarn, or their lockfiles. Each extension that has a `package.json` is a
standalone pnpm project with committed `pnpm-lock.yaml` and
`pnpm-workspace.yaml`; these files are copied into generated output. The root
`extensions/pnpm-lock.yaml` is development-only, gitignored, and not deployed.

Every extension package's `pnpm-workspace.yaml` must include:

```yaml
nodeLinker: hoisted
dangerouslyAllowAllBuilds: true
```

When adding or updating an extension dependency, edit that extension's
`package.json`, run `pnpm install` in its directory, and commit its lockfile.

## Verification

Use the narrowest non-destructive check appropriate to the change:

- prompts, agent definitions, and skills: `just build`
- manifest or config changes: `just build`, then `just diff` when inspection
  against the destination is requested
- extension changes: `just build` and the extension's typecheck when relevant
- deployment pipeline changes: inspect `just --list` and build output; run
  `just deploy` only when deployment is explicitly requested

Do not claim a build or deploy succeeded without running that command.
