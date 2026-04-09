# Per-Profile Configuration Examples

This document shows practical examples of using profile-specific config overrides.

## Config Merge Order

```
Base → Environment → Profile
```

For example, `mcp.json` merges in this order:
1. `config/mcp.base.json` (empty by default)
2. `config/work/mcp.json` or `config/home/mcp.json` (environment-specific)
3. `profiles/coding/config/mcp.json` (profile-specific override)

## Example 1: Different MCP Servers per Profile

### Coding Profile
Want GitHub and filesystem MCP servers for coding work:

```json
// profiles/coding/config/mcp.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/dev"]
    }
  }
}
```

### Personal Profile
Want different MCP servers for personal tasks:

```json
// profiles/personal/config/mcp.json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "notes": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]
    }
  }
}
```

## Example 2: Different Model Preferences

### Coding Profile
Prefer faster models for coding:

```json
// profiles/coding/config/settings.json
{
  "model": {
    "default": "stripe-google/gemini-3-flash"
  }
}
```

### Personal Profile
Prefer stronger models for personal research:

```json
// profiles/personal/config/settings.json
{
  "model": {
    "default": "stripe-anthropic/claude-opus-4.6"
  }
}
```

## Example 3: Environment + Profile Layering

### Base Config (All profiles, all environments)
```json
// config/mcp.base.json
{
  "mcpServers": {
    "common-tool": {
      "command": "npx",
      "args": ["-y", "@example/common-mcp"]
    }
  }
}
```

### Work Environment (All profiles at work)
```json
// config/work/mcp.json
{
  "mcpServers": {
    "work-only-tool": {
      "command": "/usr/local/bin/work-mcp-server"
    }
  }
}
```

### Coding Profile (Only coding profile)
```json
// profiles/coding/config/mcp.json
{
  "mcpServers": {
    "coding-specific-tool": {
      "command": "npx",
      "args": ["-y", "@example/coding-mcp"]
    }
  }
}
```

**Result**: Coding profile at work gets all three MCP servers merged together.

## How to Add Profile-Specific Config

1. Create the config directory:
   ```bash
   mkdir -p profiles/<profile-name>/config
   ```

2. Add your override file (settings.json, models.json, or mcp.json):
   ```bash
   cat > profiles/coding/config/mcp.json <<EOF
   {
     "mcpServers": {
       "my-server": { ... }
     }
   }
   EOF
   ```

3. Rebuild and deploy:
   ```bash
   just deploy coding
   ```

4. Verify the merged config:
   ```bash
   cat ~/.pi/agent/mcp.json
   ```

## Supported Config Files

Any config file with a `config/*.base.json` can have profile overrides:

- **settings.json** — Pi agent settings
- **models.json** — Model definitions  
- **mcp.json** — MCP server configuration

To add a new config type:
1. Create `config/<name>.base.json`
2. Optionally add environment overlays in `config/home/` or `config/work/`
3. Add profile overrides in `profiles/<profile>/config/<name>.json`
4. The build script automatically discovers and merges all `*.base.json` files
