#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

export NODE_ENV="${NODE_ENV:-production}"
node scripts/verify-openshell-production.mjs .env

LOGDIR="logs"
mkdir -p "$LOGDIR"

# Rotate previous logs before starting (launchd truncates StandardOutPath
# on each process start, so we preserve the old log here instead).
for f in "$LOGDIR/server-stdout.log" "$LOGDIR/server-stderr.log"; do
  if [ -s "$f" ]; then
    mv "$f" "${f%.log}.$(date +%Y%m%d-%H%M%S).log"
  fi
done

# Prune rotated logs older than 7 days
find "$LOGDIR" -name 'server-std*.????????-??????.log' -mtime +7 -delete 2>/dev/null || true

exec node dist/index.js
