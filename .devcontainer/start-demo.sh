#!/usr/bin/env bash
# Start the demo in the background when the codespace starts (devcontainer.json, postStartCommand).
# FINANCE_DEMO_CODESPACE makes a throwaway login, shown on the sign-in page, and accepts the Origin
# GitHub's port forwarding writes. The server refuses it over anything but the untracked demo data
# (src/server/codespace.ts). It stays on 127.0.0.1: Codespaces forwards the port from inside.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .work
log=.work/codespace-demo.log
if curl -fsS -o /dev/null http://127.0.0.1:4770/api/health 2>/dev/null; then
  echo "The demo is already running on port 4770."
  exit 0
fi
FINANCE_DEMO_CODESPACE=1 setsid nohup npm run demo >"$log" 2>&1 < /dev/null &
echo "Starting the demo on port 4770 (log: $log). It opens in your browser when it's ready."
