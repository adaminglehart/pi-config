# Pi Agent Configuration

Standalone Pi configuration repo managed by Chezmoi, separate from main dotfiles.

## Structure

```
~/dev/pi-config/           # Source directory
  ├── agents/              # Agent definitions (scout, worker, planner, etc.)
  ├── extensions/          # Custom Pi extensions
  ├── skills/              # Task-specific instruction packages
  ├── AGENTS.md            # Workflow rules and guidelines
  ├── APPEND_SYSTEM.md     # Additional system prompt content
  ├── settings.json.tmpl   # Settings template (merges base + environment)
  ├── models.json.tmpl     # Models template (merges base + environment)
  └── .chezmoitemplates/pi/
      ├── settings.base.json       # Shared settings
      ├── settings.work.json       # Work-specific overrides (Stripe LiteLLM)
      ├── settings.home.json       # Home-specific overrides (Anthropic API)
      ├── models.base.json         # Shared models
      ├── models.work.json         # Work models (Stripe providers)
      └── models.home.json         # Home models (Anthropic direct)
```

Installed to: `~/.pi/agent/`

## Environment Detection

Chezmoi automatically detects environment based on hostname:
- `Adams-MacBook-Pro.local` → `home`
- All other hostnames → `work`

Edit `.chezmoi.yaml.tmpl` to customize detection logic.

## Commands

```bash
# Preview what would change
cd ~/dev/pi-config && chezmoi diff

# Apply changes to ~/.pi/agent/
cd ~/dev/pi-config && chezmoi apply

# Or use the helper script
~/dev/pi-config/apply.sh

# Check status
cd ~/dev/pi-config && chezmoi status
```

## Editing Files

**Always edit in `~/dev/pi-config/` (the source), not `~/.pi/agent/` (the target).**

After editing, run:
```bash
cd ~/dev/pi-config && chezmoi apply
# Or
~/dev/pi-config/apply.sh
```

## Environment-Specific Config

### Settings
- Edit `.chezmoitemplates/pi/settings.base.json` for shared settings
- Edit `.chezmoitemplates/pi/settings.work.json` for work-only overrides
- Edit `.chezmoitemplates/pi/settings.home.json` for home-only overrides

### Models
- Edit `.chezmoitemplates/pi/models.work.json` for Stripe LiteLLM providers
- Edit `.chezmoitemplates/pi/models.home.json` for direct Anthropic API

The templates automatically merge base + environment configs.

## Setup on New Machine

```bash
# Clone this repo
git clone <repo-url> ~/dev/pi-config

# Apply configuration
cd ~/dev/pi-config
chezmoi init
chezmoi apply
```
