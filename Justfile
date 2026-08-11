# Typecheck build tooling and extensions
check:
    pnpm exec tsc --project tsconfig.json
    pnpm --dir extensions exec tsc --project tsconfig.json

# Build the primary Pi agent configuration
build:
    bun run build.ts

# Download all current ui.sh skills into the repository
update-ui-skills:
    fnox exec -- bun run scripts/update-ui-skills.ts

# Deploy the built primary agent to its destination
_deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(bun scripts/dest.ts)
    BUILD="build/agent"
    if [ ! -d "$BUILD" ]; then
      echo "error: build/agent/ not found. Run 'just build' first."
      exit 1
    fi
    if [ ! -f "$BUILD/settings.json" ]; then
      echo "error: build/agent/ is incomplete (settings.json is missing). Run 'just build' first."
      exit 1
    fi
    echo "Deploying primary agent → $DEST"
    mkdir -p "$DEST"
    bun scripts/managed-destination.ts reconcile "$BUILD" "$DEST"
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
    DEST=$(bun scripts/dest.ts)
    BUILD="build/agent"
    if [ ! -d "$BUILD" ]; then
      echo "error: build/agent/ not found. Run 'just build' first."
      exit 1
    fi
    diff -rq "$BUILD" "$DEST" \
      --exclude node_modules \
      --exclude sessions \
      --exclude auth.json \
      --exclude git \
      --exclude status \
      --exclude mcp-cache.json \
      --exclude mcp-onboarding.json \
      --exclude missions \
      --exclude models-store.json \
      --exclude npm \
      --exclude pi-crash.log \
      --exclude pi-debug.log \
      --exclude run-history.jsonl \
      --exclude trust.json \
      || true

# Clean build output and managed files from the destination
clean:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(bun scripts/dest.ts)
    echo "Cleaning build/agent/ and managed files in $DEST"
    rm -rf "build/agent"
    bun scripts/managed-destination.ts clean "$DEST"
    echo "✓ Cleaned primary agent"

# Import historical Pi JSONL sessions into Hindsight (dry-run by default; pass --write to ingest)
hindsight-import *args:
    bun scripts/import-sessions-to-hindsight.ts {{ args }}

# Generate honcho .env file for the current environment
honcho-env:
    #!/usr/bin/env bash
    set -euo pipefail
    ENV=$(bun scripts/env.ts)
    echo "Generating honcho/.env for environment: $ENV"
    TMP=$(mktemp)
    cat config/honcho.env.base > "$TMP"
    printf '\n' >> "$TMP"
    cat "config/$ENV/honcho.env" >> "$TMP"
    mkdir -p honcho
    # we use chezmoi just for the templating here, not for broader management of configs
    chezmoi execute-template < "$TMP" > honcho/.env
    rm -f "$TMP"
    echo "✓ honcho/.env generated"
