#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Building packages + server..."
npm run build:server

echo "Building frontend..."
npm run build

echo "Restarting service..."
# kickstart -k sends SIGTERM and waits for termination before restarting.
launchctl kickstart -k "gui/$(id -u)/com.mitzo.server"

echo "Deployed and restarted."
