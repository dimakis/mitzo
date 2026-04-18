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

echo "Restarting service..."
# kickstart -k sends SIGTERM and waits for termination before restarting.
launchctl kickstart -k "gui/$(id -u)/com.mitzo.server"

echo "Deployed and restarted."
