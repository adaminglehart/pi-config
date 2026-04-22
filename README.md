# Pi Agent Configuration

Profile-based Pi configuration with shared libraries and per-profile customization.

## Structure

```
~/dev/pi-config/
  ├── profiles/            # Agent profiles (coding, personal, etc.)
  │   ├── coding/
  │   │   ├── package.json        # Profile manifest (extensions, skills, vars)
  │   │   ├── config/             # Profile-specific config overrides
  │   │   │   ├── mcp.json        # MCP servers for this profile
  │   │   │   ├── settings.json   # Settings overrides
  │   │   │   └── models.json     # Model overrides
  │   │   ├── AGENTS.md           # Profile-specific rules
  │   │   ├── APPEND_SYSTEM.md    # Profile-specific system prompt
  │   │   └── agents/             # Profile-specific agent definitions
  │   └── personal/
  │       └── ...
  ├── extensions/          # Shared Pi extensions
  ├── skills/              # Shared task-specific instruction packages
  ├── shared/lib/          # Shared library code (_lib/)
  ├── config/              # Base and environment-specific config
  │   ├── settings.base.json      # Base settings for all profiles
  │   ├── models.base.json        # Base models for all profiles
  │   ├── mcp.base.json           # Base MCP configuration
  │   ├── home/
  │   │   ├── settings.json       # Home environment overrides
  │   │   ├── models.json         # Home models (Anthropic API)
  │   │   └── honcho.env          # Home Honcho config
  │   └── work/
  │       ├── settings.json       # Work environment overrides
  │       ├── models.json         # Work models (LiteLLM proxy)
  │       └── honcho.env          # Work Honcho config
  └── build/               # Build output (gitignored)
      └── coding/agent/    # Ready to deploy → ~/.pi/agent/
```

## Config Merge Order

Configs are merged in this order (later overrides earlier):

1. **Base** (`config/*.base.json`) — shared across all profiles and environments
2. **Environment** (`config/{home,work}/*.json`) — environment-specific overrides
3. **Profile** (`profiles/{name}/config/*.json`) — profile-specific overrides

Example: `mcp.json` for coding profile on work machine:
```
config/mcp.base.json          # Base MCP servers
→ config/work/mcp.json        # Add work-specific servers
→ profiles/coding/config/mcp.json  # Add coding-specific servers
```

This allows you to:
- Share common config across all profiles (base)
- Adjust for home vs work environments (environment layer)
- Customize per agent profile (profile layer)

## Environment Detection

Automatically detects environment based on hostname:
- `Adams-MacBook-Pro.local` → `home`
- All other hostnames → `work`

Override with: `PI_BUILD_ENV=home just build coding`

## Commands

```bash
# Build a single profile
just build coding

# Build all profiles
just build-all

# Deploy a built profile to ~/.pi/agent/
just apply-profile coding

# Build and deploy all profiles
just apply

# Build and deploy a single profile
just deploy coding

# Show diff between build output and deployed files
just diff coding

# Clean build output and deployed files
just clean coding

# Generate honcho/.env for current environment
just honcho-env
```

## Editing Files

**Always edit in `~/dev/pi-config/` (the source), not `~/.pi/agent/` (the target).**

After editing, build and deploy:
```bash
just deploy coding
# Or deploy all profiles:
just apply
```

## Adding Profile-Specific Config

To customize config for a specific profile (e.g., different MCP servers for coding vs personal):

1. Create `profiles/<profile>/config/<config-name>.json`
2. Add overrides (will be deep-merged with base + environment)
3. Rebuild: `just build <profile>`

Example — custom MCP servers for coding profile:

```bash
# profiles/coding/config/mcp.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

Supported config files:
- `settings.json` — Pi agent settings
- `models.json` — Model definitions
- `mcp.json` — MCP server configuration

## Setup on New Machine

```bash
# Clone this repo
git clone <repo-url> ~/dev/pi-config

# Build and deploy all profiles
cd ~/dev/pi-config
just apply
```
