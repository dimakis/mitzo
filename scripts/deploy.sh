#!/usr/bin/env bash
set -euo pipefail

MITZO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MITZO_DIR"

echo "=== Mitzo Deploy ==="
echo "Dir: $MITZO_DIR"
echo ""

echo "--- Switching to main ---"
git checkout main
echo ""

echo "--- Pulling latest (fast-forward only) ---"
git fetch origin main
git pull --ff-only origin main
echo "Commit: $(git log --oneline -1)"
echo ""

echo "--- Installing dependencies ---"
npm install --silent
echo ""

echo "--- Building frontend ---"
npm run build --silent
echo ""

echo "--- Scheduling restart (2s delay so response can be sent) ---"
nohup bash -c "sleep 2 && pm2 restart mitzo" > /tmp/mitzo-restart.log 2>&1 &
echo "Server will restart in 2 seconds. Connection will briefly drop."
echo "Commit: $(git log --oneline -1)"
echo ""

echo "=== Deploy complete ==="
