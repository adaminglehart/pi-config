#!/bin/bash
# Install npm dependencies for pi-personal extensions that have a package.json
set -e

EXTENSIONS_DIR="$HOME/.pi-personal/agent/extensions"

if [ ! -d "$EXTENSIONS_DIR" ]; then
  exit 0
fi

for pkg in "$EXTENSIONS_DIR"/*/package.json; do
  [ -f "$pkg" ] || continue
  dir="$(dirname "$pkg")"
  if [ ! -d "$dir/node_modules" ] || [ "$pkg" -nt "$dir/node_modules" ]; then
    echo "Installing deps for $(basename "$dir")..."
    (cd "$dir" && npm install --silent)
  fi
done
