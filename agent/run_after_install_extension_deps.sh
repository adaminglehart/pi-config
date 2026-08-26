#!/bin/bash
# Install production dependencies in the staged build before deployment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"

if [ ! -d "$EXTENSIONS_DIR" ]; then
  exit 0
fi

for pkg in "$EXTENSIONS_DIR"/*/package.json; do
  [ -f "$pkg" ] || continue
  dir="$(dirname "$pkg")"
  echo "Installing production deps for $(basename "$dir")..."
  (cd "$dir" && pnpm install --prod --frozen-lockfile --silent)
done
