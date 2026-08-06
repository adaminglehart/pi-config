#!/bin/bash
# Install pnpm dependencies for pi extensions that have a package.json
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"

if [ ! -d "$EXTENSIONS_DIR" ]; then
  exit 0
fi

for pkg in "$EXTENSIONS_DIR"/*/package.json; do
  [ -f "$pkg" ] || continue
  dir="$(dirname "$pkg")"
  if [ ! -d "$dir/node_modules" ] || [ "$pkg" -nt "$dir/node_modules" ]; then
    echo "Installing deps for $(basename "$dir")..."
    (cd "$dir" && pnpm install --silent)
  fi
done
