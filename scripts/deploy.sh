#!/bin/bash
set -e
cd "$(dirname "$0")/.."

MITZO_HOME="$(pwd)"
PLIST_DEST="$HOME/Library/LaunchAgents/com.mitzo.server.plist"

echo "Building packages + server..."
npm run build:server

echo "Building frontend..."
npm run build

# Generate launchd plist from template (replaces __MITZO_HOME__ placeholder)
echo "Installing launchd plist..."
sed "s|__MITZO_HOME__|${MITZO_HOME}|g" com.mitzo.server.plist > "$PLIST_DEST"

# Install podman machine launchd agent
PODMAN_PLIST_DEST="$HOME/Library/LaunchAgents/com.mitzo.podman-machine.plist"
sed "s|__MITZO_HOME__|${MITZO_HOME}|g" infra/com.mitzo.podman-machine.plist > "$PODMAN_PLIST_DEST"
launchctl bootout "gui/$(id -u)/com.mitzo.podman-machine" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PODMAN_PLIST_DEST"

# Ensure podman machine exists and is running before bringing up containers.
# The launchd plist also handles init+start at boot — podman uses lock files
# so concurrent attempts are safe, just redundant.
if ! podman machine inspect --format '{{.State}}' 2>/dev/null | grep -q Running; then
  if ! podman machine inspect 2>/dev/null >/dev/null; then
    echo "Initializing podman machine..."
    podman machine init
  fi
  echo "Starting podman machine..."
  podman machine start
fi

echo "Ensuring observability stack is running..."
docker compose up -d

echo "Restarting service..."
# kickstart -k sends SIGTERM and waits for termination before restarting.
launchctl kickstart -k "gui/$(id -u)/com.mitzo.server"

echo "Deployed and restarted."
