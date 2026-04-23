# AGENTS.md

**Pi-config specific guidelines.**

This repo is the **source of truth** for Adam's Pi agent configuration. It defines shared extensions, shared skills, environment overlays, and per-profile agent builds, then generates deployable agent directories such as `~/.pi/agent`.

## What this repo is

This is a **profile-based Pi configuration repo**, not a normal app/service.

The main workflow is:

1. Edit source files in `~/dev/pi-config`
2. Build one or more profiles into `build/<profile>/agent/`
3. Deploy the built output into the profile's configured destination (`~/.pi/agent`, `~/.pi-personal/agent`, etc.)

**Do not edit deployed files directly** in `~/.pi/...` when they are managed here.

## Source of truth vs generated output

Authoritative source directories are:

- `profiles/`
- `extensions/`
- `skills/`
- `config/`
- `shared/lib/`
- `scripts/`
- `build.ts`
- `Justfile`

Generated or deployed artifacts are:

- `build/`
- target directories like `~/.pi/agent` and `~/.pi-personal/agent`

When changing Pi config, always update the source repo first, then deploy with the repo's apply flow.

## Deployment

This repo is deployed using the justfile. Always use:

```bash
cd ~/dev/pi-config && just apply
```

For a single profile, prefer:

```bash
cd ~/dev/pi-config && just deploy coding
```

Do not use chezmoi for this repository.

## Build system

This repo uses:

- **Bun** for build scripts
- **Just** for build/deploy task entrypoints
- **mise** for tool installation and loading `.env`

Key files:

- `build.ts` — main profile build pipeline
- `Justfile` — user-facing build/deploy commands
- `scripts/dest.ts` — resolves a profile's deployment destination
- `.mise.toml` — installs Bun and loads `.env`

### Important build behavior

`build.ts` does all of the following:

- reads `profiles/<profile>/package.json` or `package.jsonc`
- determines the target destination from `pi.destDir`
- detects environment as `home` or `work`
- copies selected extensions and skills into `build/<profile>/agent/`
- copies profile-level files like `AGENTS.md`, `APPEND_SYSTEM.md`, `agents/`, and scripts
- copies shared library code from `shared/lib/` into `extensions/_lib/`
- generates merged config files like `settings.json`, `models.json`, and `mcp.json`
- resolves `${ENV_VAR}` placeholders from `.env`
- resolves `{{var.name}}` placeholders from profile manifest vars
- removes stale deployed extensions/skills that were removed from the profile

### Environment detection

By default, the build uses:

- `home` when hostname is `MacBook-Pro.local`
- `work` for every other hostname

You can override this explicitly:

```bash
PI_BUILD_ENV=home just build coding
```

If environment-specific behavior matters, prefer checking `build.ts` over guessing.

## Project structure

### Top level

- `build.ts` — Bun build script for assembling a profile
- `Justfile` — build/deploy/diff/clean commands
- `README.md` — human-facing repo documentation
- `docs/` — additional documentation
- `.mise.toml` — tool/runtime setup and `.env` loading
- `.env.example` — template for required environment variables

### `profiles/`

Each directory under `profiles/` defines a deployable Pi profile.

Current profiles include:

- `profiles/coding/`
- `profiles/personal/`

A profile typically contains:

- `package.json` or `package.jsonc` — manifest with `pi.destDir`, `extensions`, `skills`, optional `vars`
- `AGENTS.md` — profile-specific working instructions
- `APPEND_SYSTEM.md` — extra system prompt content
- `agents/` — profile-local agent definitions
- `config/` — profile-specific config overlays
- optional helper scripts such as `run_after_install_extension_deps.sh`

### `extensions/`

Shared Pi extensions live here.

This repo supports both:

- **directory-based extensions** like `extensions/dev-browser/`
- **single-file extensions** like `extensions/websearch.ts`

`extensions/package.json` and `extensions/tsconfig.json` are the shared dev/typecheck setup for extension development, and are also copied into build output where needed.

When modifying or adding an extension:

1. put it under `extensions/`
2. add it to the relevant profile manifest under `pi.extensions`
3. deploy the profile

### `skills/`

Shared task-specific skills live here.

When adding a skill:

1. create `skills/<name>/`
2. add its `SKILL.md` and any supporting files
3. add the skill name to the relevant profile manifest under `pi.skills`
4. deploy the profile

### `config/`

This holds shared and environment-specific config layers.

Main files/directories:

- `config/settings.base.json`
- `config/models.base.json`
- `config/mcp.base.json`
- `config/home/`
- `config/work/`
- `config/honcho.env.base`

Use this directory for config shared across profiles or specific to `home` vs `work`.

### `shared/lib/`

Shared extension helper code lives here. During build it is copied to:

```text
build/<profile>/agent/extensions/_lib/
```

Use this for code intentionally shared across multiple extensions.

### `build/`

This is generated output only.

Each build lands in:

```text
build/<profile>/agent/
```

Do not hand-edit files here unless you're debugging the build itself.

### `honcho/`

Support code for the Honcho memory service lives here. This is related project infrastructure, not the main Pi profile source tree.

## Configuration layering and merge order

Generated config files are merged in this order:

1. `config/<name>.base.json(.c)`
2. `config/<env>/<name>.json(.c)`
3. `config/<env>/<name>.local.json(.c)`
4. `profiles/<profile>/config/<name>.json(.c)`
5. `profiles/<profile>/config/<name>.local.json(.c)`

Later layers override earlier layers.

Examples of supported generated config files:

- `settings.json`
- `models.json`
- `mcp.json`

### Local overrides

`*.local.json` and `*.local.jsonc` are machine-specific and gitignored. Use them for:

- secrets
- local paths
- internal-only MCP servers
- machine-specific model/provider overrides

Do not commit local override files.

### Environment variables in config

Config JSON can use `${VAR_NAME}` placeholders. These are resolved at build time from `.env`.

If a referenced variable is missing, the build should fail instead of silently continuing.

## Profile manifest conventions

Profile manifests live at:

- `profiles/<profile>/package.json`
- or `profiles/<profile>/package.jsonc`

Use the `pi` block for Pi-specific config such as:

- `destDir`
- `extensions`
- `skills`
- `vars`

### `vars`

`pi.vars` is environment-scoped and used for `{{var.name}}` substitution in copied profile files.

That is appropriate for values like profile-level model aliases or environment-specific prompt substitutions.

## Editing conventions

### General

- Edit the source repo, not deployed output
- Prefer the smallest change that matches existing structure
- Keep profile-specific behavior inside the relevant profile when possible
- Put shared behavior in `extensions/`, `skills/`, `config/`, or `shared/lib/` only when it is actually shared
- Re-read files before editing if there may have been manual changes

### Where changes should go

- shared extension logic → `extensions/`
- shared skill instructions → `skills/`
- shared config defaults → `config/*.base.json`
- home/work-specific config → `config/home/` or `config/work/`
- profile-only config or agent behavior → `profiles/<profile>/`
- shared extension helper code → `shared/lib/`
- build pipeline changes → `build.ts`, `scripts/`, or `Justfile`

### Extensions and dependencies

If an extension has its own `package.json`, deployment may rely on the profile's `run_after_install_extension_deps.sh` hook to install extension dependencies in the deployed target.

For coding profile changes, check whether `profiles/coding/run_after_install_extension_deps.sh` needs to pick up the new extension automatically.

### JSON vs JSONC

This repo supports both `.json` and `.jsonc` in key places.

- Prefer existing file style
- Use `.jsonc` when comments or trailing commas are useful and already part of the pattern
- Do not switch formats gratuitously

## Verification

After making changes, verify with the narrowest appropriate command.

Common commands:

```bash
# Build one profile
just build coding

# Deploy one profile
just deploy coding

# Deploy all profiles
just apply

# Compare built output with deployed destination
just diff coding

# Clean generated output and managed deployed files for one profile
just clean coding
```

### Recommended verification by change type

- `AGENTS.md`, prompts, skills only: usually `just build <profile>` is enough
- profile manifest/config changes: `just build <profile>` and often `just diff <profile>`
- extension changes: `just build <profile>` and, if relevant, typecheck extension code
- deployment behavior changes: `just deploy <profile>` and inspect deployed output

If you claim a build or deploy worked, run the actual command and show the result.

## Model configuration

Models are generated from layered config files and written into the built profile output.

The coding profile currently uses environment-specific profile vars for model aliases, and base/environment/profile config layering for `models.json`.

The `openai-codex` provider is built-in and uses OAuth authentication stored in `auth.json` outside this repo. Use `/login openai-codex` when authentication is needed.

## Quick rules for future agents

- This repo is a **generator** for Pi agent directories
- `~/dev/pi-config` is the source of truth
- `build/` and `~/.pi*` are outputs, not the place to make lasting edits
- Use `just apply` to roll out changes
- Put shared things in shared directories and profile-specific things in `profiles/<profile>/`
- Respect config layering instead of hardcoding environment-specific values
