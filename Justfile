# Build the primary Pi agent configuration
build:
    bun run build.ts

# Read destDir from the root pi.jsonc manifest
_dest:
    @bun scripts/dest.ts

# Deploy the built primary agent to its destination
_deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(just _dest)
    BUILD="build/agent"
    if [ ! -d "$BUILD" ]; then
      echo "error: build/agent/ not found. Run 'just build' first."
      exit 1
    fi
    echo "Deploying primary agent → $DEST"
    mkdir -p "$DEST"
    rsync -a --exclude 'node_modules' "$BUILD/" "$DEST/"
    # Install extension pnpm dependencies
    if [ -f "$DEST/run_after_install_extension_deps.sh" ]; then
      bash "$DEST/run_after_install_extension_deps.sh"
    fi
    echo "✓ Deployed primary agent → $DEST"

# Build and deploy the primary agent
apply: (build) _deploy

# Build and deploy the primary agent
deploy: apply

# Show diff between build output and deployed destination
diff:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(just _dest)
    BUILD="build/agent"
    if [ ! -d "$BUILD" ]; then
      echo "error: build/agent/ not found. Run 'just build' first."
      exit 1
    fi
    diff -rq "$BUILD" "$DEST" --exclude node_modules --exclude sessions --exclude auth.json --exclude pi-debug.log --exclude git --exclude status || true

# Clean build output and managed files from the destination
clean:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(just _dest)
    echo "Cleaning build/agent/ and $DEST (excluding sessions, auth.json, git, node_modules)"
    rm -rf "build/agent"
    for item in agents AGENTS.md APPEND_SYSTEM.md extensions skills settings.json models.json mcp.json fnox.toml run_after_install_extension_deps.sh .chezmoiignore; do
      rm -rf "$DEST/$item"
    done
    echo "✓ Cleaned primary agent"

# Import historical Pi JSONL sessions into Hindsight (dry-run by default; pass --write to ingest)
hindsight-import *args:
    bun scripts/import-sessions-to-hindsight.ts {{ args }}

# Generate honcho .env file for the current environment
honcho-env:
    #!/usr/bin/env bash
    set -euo pipefail
    HOSTNAME=$(hostname)
    if [ "$HOSTNAME" = "MacBook-Pro.local" ]; then
      ENV="home"
    else
      ENV="work"
    fi
    echo "Generating honcho/.env for environment: $ENV"
    TMP=$(mktemp)
    cat config/honcho.env.base > "$TMP"
    printf '\n' >> "$TMP"
    cat "config/$ENV/honcho.env" >> "$TMP"
    # we use chezmoi just for the templating here, not for broader management of configs
    chezmoi execute-template < "$TMP" > honcho/.env
    rm -f "$TMP"
    echo "✓ honcho/.env generated"
