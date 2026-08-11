# Pi Agent Configuration

This repository is the source of truth for the primary Pi agent deployed to
`~/.pi/agent`. It stages a single agent configuration from root-level sources;
`profiles/personal/` remains untouched as deferred migration input and is not
part of the build or deployment pipeline.

## Structure

```text
~/dev/pi-config/
├── pi.jsonc              # Primary destination and enabled extensions/skills
├── agent/                 # Primary prompts, agent definitions, deploy hook
├── config/                # Base and environment-specific JSON configuration
├── extensions/            # Shared Pi extensions
├── skills/                # Shared task-specific instruction packages
├── shared/lib/            # Shared extension code staged as extensions/_lib/
├── build/agent/           # Generated primary-agent output (gitignored)
├── build.ts               # Primary build pipeline
└── Justfile               # Build, deploy, comparison, and cleanup commands
```

Edit source files in this repository, not `~/.pi/agent`.

## Primary manifest

`pi.jsonc` declares the sole active agent's deployment destination and its
extension and skill allowlists. Add an extension or skill to the respective
source directory first, then explicitly add its name to the appropriate
allowlist in `pi.jsonc`.

ui.sh skills are the exception. `just update-ui-skills` downloads every skill
available to `UIDOTSH_TOKEN` into `skills/` and updates
`config/ui-sh-skills.json`. The build adds that checked-in list to the primary
skill allowlist. Updating is explicit so normal builds stay offline and do not
change reviewed skill content.

## Configuration merge order

Generated `settings.json`, `models.json`, and `mcp.json` merge later layers
over earlier ones:

1. **Base** — `config/<name>.base.json(.c)`
2. **Environment** — `config/<env>/<name>.json(.c)`
3. **Environment local** — `config/<env>/<name>.local.json(.c)` (gitignored)

The build detects `home` on `MacBook-Pro.local` and uses `work` elsewhere. To
inspect another environment without changing the hostname, set
`PI_BUILD_ENV`, for example `PI_BUILD_ENV=home just build`.

String values using `${VAR_NAME}` are resolved from the build environment.
Missing variables fail the build. Model aliases from merged settings are also
substituted into primary agent files.

## Commands

```bash
# Download all current ui.sh skills through the fnox-managed token
just update-ui-skills

# Build build/agent/
just build

# Build and deploy the primary agent to the destination in pi.jsonc
just deploy
# Equivalent build-and-deploy command
just apply

# Compare build/agent/ with the deployed agent (inspection only)
just diff

# Remove primary generated output and managed deployed files
just clean

# Generate honcho/.env for the detected environment
just honcho-env
```

Deployment rsyncs the generated output while excluding `node_modules`, then
runs `agent/run_after_install_extension_deps.sh`. The hook discovers its own
deployed directory and runs `pnpm install` for each staged extension package.

## Setup on a new machine

```bash
git clone <repo-url> ~/dev/pi-config
cd ~/dev/pi-config
mise trust
mise install
cp .env.example .env
# Edit .env with required provider credentials and URLs.
just deploy
```

To use the optional Honcho memory service, run `just honcho-env`, then start it
from `honcho/` using its documented compose configuration.
