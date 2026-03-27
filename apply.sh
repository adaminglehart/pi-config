#!/usr/bin/env bash
# Helper script to apply Pi config changes

set -e

cd "$(dirname "$0")"

echo "Applying Pi config from ~/dev/pi-config to ~/.pi/agent/..."
chezmoi apply "$@"
echo "✓ Done"
