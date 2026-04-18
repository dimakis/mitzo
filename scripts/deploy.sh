#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Building packages + server..."
npm run build:server

echo "Building frontend..."
npm run build

echo "Gracefully stopping service..."
SERVICE="gui/$(id -u)/com.mitzo.server"
launchctl kill SIGTERM "$SERVICE" 2>/dev/null || true
sleep 3

echo "Restarting service..."
launchctl kickstart -k "$SERVICE"

echo "Deployed and restarted."
