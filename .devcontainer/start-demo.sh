#!/usr/bin/env bash
# Run the demo in the editor's terminal when it attaches to the codespace (devcontainer.json,
# postAttachCommand); closing that terminal stops it, and this script starts it again.
# FINANCE_DEMO_CODESPACE makes a throwaway login, shown on the sign-in page, and accepts the Origin
# GitHub's port forwarding writes. The server refuses it over anything but the untracked demo data
# (src/server/codespace.ts). It stays on 127.0.0.1: Codespaces forwards the port from inside.
set -euo pipefail
cd "$(dirname "$0")/.."
if curl -fsS -o /dev/null http://127.0.0.1:4770/api/health 2>/dev/null; then
  echo "The demo is already running on port 4770 (Ports tab: \"Counting House demo\")."
  exit 0
fi
echo "Building and starting the demo on port 4770. It opens in your browser when it's ready."
export FINANCE_DEMO_CODESPACE=1
exec npm run demo
