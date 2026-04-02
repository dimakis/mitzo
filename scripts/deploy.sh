#!/usr/bin/env bash
set -euo pipefail

MITZO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MITZO_DIR"

echo "=== Mitzo Deploy ==="
echo "Dir: $MITZO_DIR"
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

echo "--- Restarting server ---"
pm2 restart mitzo
pm2 show mitzo | grep -E "status|uptime|pid"
echo ""

echo "=== Deploy complete ==="
