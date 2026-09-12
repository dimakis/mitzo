#!/bin/bash
set -e
cd "$(dirname "$0")/.."

MITZO_HOME="$(pwd)"
PLIST_DEST="$HOME/Library/LaunchAgents/com.mitzo.server.plist"

echo "Building packages + server..."
npm run build:server

echo "Building frontend..."
npm run build

# Production validation inspects the pinned runtime image, so Podman must be
# available before the preflight runs.
if ! podman machine inspect --format '{{.State}}' 2>/dev/null | grep -qi '^running$'; then
  if ! podman machine inspect 2>/dev/null >/dev/null; then
    echo "Initializing podman machine..."
    podman machine init
  fi
  echo "Starting podman machine..."
  podman machine start ||
    podman machine inspect --format '{{.State}}' 2>/dev/null | grep -qi '^running$'
fi

echo "Validating OpenShell production bundle..."
NODE_ENV=production node scripts/verify-openshell-production.mjs .env

# Generate launchd plist from template (replaces __MITZO_HOME__ placeholder)
echo "Installing launchd plist..."
sed "s|__MITZO_HOME__|${MITZO_HOME}|g" com.mitzo.server.plist > "$PLIST_DEST"

# Install podman machine launchd agent
PODMAN_PLIST_DEST="$HOME/Library/LaunchAgents/com.mitzo.podman-machine.plist"
sed "s|__MITZO_HOME__|${MITZO_HOME}|g" infra/com.mitzo.podman-machine.plist > "$PODMAN_PLIST_DEST"
launchctl bootout "gui/$(id -u)/com.mitzo.podman-machine" 2>/dev/null || true
for _ in {1..50}; do
  if ! launchctl print "gui/$(id -u)/com.mitzo.podman-machine" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PODMAN_PLIST_DEST"

echo "Ensuring observability stack is running..."
docker compose -p mitzo up -d

echo "Restarting service..."
launchctl bootout "gui/$(id -u)/com.mitzo.server" 2>/dev/null || true
for _ in {1..50}; do
  if ! launchctl print "gui/$(id -u)/com.mitzo.server" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "Deployed and restarted."
