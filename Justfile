# Build a single profile
build profile:
    bun run build.ts {{profile}}

# Build all profiles
build-all:
    #!/usr/bin/env bash
    set -euo pipefail
    for dir in profiles/*/; do
      profile=$(basename "$dir")
      just build "$profile"
    done

# Deploy a single built profile to its destination
apply-profile profile:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('profiles/{{profile}}/package.json','utf-8')).pi.destDir.replace('~', process.env.HOME))")
    BUILD="build/{{profile}}/agent"
    if [ ! -d "$BUILD" ]; then
      echo "error: build/{{profile}}/agent/ not found. Run 'just build {{profile}}' first."
      exit 1
    fi
    echo "Deploying {{profile}} → $DEST"
    mkdir -p "$DEST"
    rsync -a --exclude 'node_modules' "$BUILD/" "$DEST/"
    # Install extension npm deps
    if [ -f "$DEST/run_after_install_extension_deps.sh" ]; then
      bash "$DEST/run_after_install_extension_deps.sh"
    fi
    echo "✓ Deployed {{profile}} → $DEST"

# Build and deploy all profiles
apply:
    #!/usr/bin/env bash
    set -euo pipefail
    for dir in profiles/*/; do
      profile=$(basename "$dir")
      just build "$profile"
      just apply-profile "$profile"
    done

# Build and deploy a single profile
deploy profile: (build profile) (apply-profile profile)

# Show diff between build output and deployed destination
diff profile:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('profiles/{{profile}}/package.json','utf-8')).pi.destDir.replace('~', process.env.HOME))")
    BUILD="build/{{profile}}/agent"
    if [ ! -d "$BUILD" ]; then
      echo "error: build/{{profile}}/agent/ not found. Run 'just build {{profile}}' first."
      exit 1
    fi
    diff -rq "$BUILD" "$DEST" --exclude node_modules --exclude sessions --exclude auth.json --exclude pi-debug.log --exclude git --exclude status || true

# Clean build output and managed files from destination
clean profile:
    #!/usr/bin/env bash
    set -euo pipefail
    DEST=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('profiles/{{profile}}/package.json','utf-8')).pi.destDir.replace('~', process.env.HOME))")
    echo "Cleaning build/{{profile}}/ and $DEST (excluding sessions, auth.json, git, node_modules)"
    rm -rf "build/{{profile}}"
    for item in agents AGENTS.md APPEND_SYSTEM.md extensions skills settings.json models.json run_after_install_extension_deps.sh .chezmoiignore; do
      rm -rf "$DEST/$item"
    done
    echo "✓ Cleaned {{profile}}"

# Generate honcho .env file for the current environment
honcho-env:
    #!/usr/bin/env bash
    set -euo pipefail
    HOSTNAME=$(hostname)
    if [ "$HOSTNAME" = "Adams-MacBook-Pro.local" ]; then
      ENV="home"
    else
      ENV="work"
    fi
    echo "Generating honcho/.env for environment: $ENV"
    cat config/honcho.env.base > honcho/.env
    printf '\n' >> honcho/.env
    cat "config/$ENV/honcho.env" >> honcho/.env
    echo "✓ honcho/.env generated"
