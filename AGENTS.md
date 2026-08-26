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

- `pi.jsonc` — primary destination plus extension/skill selection; its
  `pi.uiShSkills` list is owned by `just update-ui-skills`
- `agent/` — `AGENTS.md` (the global agent prompt), agent definitions, deploy hook
- `extensions/` and `skills/` — shared selectable components
- `config/` — base and environment-specific generated config layers
- `shared/lib/` — code staged to `extensions/_lib/`
- `build.ts`, `scripts/`, `package.json`, `tsconfig.json`, and `Justfile` — build,
  typecheck, and deployment pipeline

Generated or deployed output:

- `build/agent/`
- `~/.pi/agent` (or the root manifest's `pi.destDir`)

Never hand-edit generated output. Do not delete unfamiliar ignored/runtime
contents from `agent/`; the primary builder deliberately excludes its runtime
`extensions/`, `skills/`, and `node_modules` directories.

## Build behavior

`README.md` documents the structure, the config merge order, and the commands.
Read it instead of duplicating that detail here. The invariants an agent must
not break:

- `build.ts` takes no profile argument. Environment is `home` on
  `MacBook-Pro.local` and `work` everywhere else. Override with `PI_BUILD_ENV`.
- An extension or skill is deployed **only** when its name is in `pi.jsonc`
  under `pi.extensions`, `pi.skills`, or `pi.uiShSkills`. Adding the source
  directory alone does nothing.
- Generated config merges three layers, later over earlier:
  `config/<name>.base.json(.c)`, `config/<env>/<name>.json(.c)`, then
  `config/<env>/<name>.local.json(.c)`. The `*.local.*` layers are gitignored
  machine-specific overrides.
- Missing `${ENV_VAR}` values fail the build. Add them to `.env`.
- `just build` writes only to `build/agent/`. The deploy step removes stale
  managed destination paths before it copies the new build.
- `scripts/managed-destination.ts` temporarily includes legacy profile-era
  paths (`build`, `build.ts`, `config`, `docs`, `Justfile`, `README.md`,
  `APPEND_SYSTEM.md`, and `.chezmoiignore`). After one successful `just apply`
  on every configured machine, remove those entries so future Pi runtime paths
  cannot collide with old cleanup names.

## Commands

```bash
just check              # Typecheck build tooling and extensions
just build              # Generate build/agent/
just apply              # Build and deploy the primary agent
just deploy             # Alias of `just apply`
just diff               # Inspect build/agent/ against its destination
just clean              # Remove generated output and managed deployed files
just update-ui-skills   # Download current ui.sh skills and refresh their allowlist
just hindsight-import   # Import historical session JSONL into Hindsight (dry run
                        # by default; pass --write to ingest)
just honcho-env         # Generate honcho/.env for the active environment
```

The deploy flow uses `scripts/dest.ts` to read root `pi.jsonc`. It runs
`agent/run_after_install_extension_deps.sh` in `build/agent/` so production
dependencies install under the repository instead of the deployment
destination. It then rsyncs the generated files and each complete extension
`node_modules` tree to the destination without running package install scripts
there.

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
