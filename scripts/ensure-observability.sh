#!/usr/bin/env bash
# Ensure the observability stack (Jaeger + Loki + Grafana + MLflow) is running.
# Called by the com.mitzo.podman-machine launchd agent after machine start,
# and can be run manually: ./scripts/ensure-observability.sh
set -euo pipefail

PODMAN="${PODMAN:-$(command -v podman 2>/dev/null || echo /opt/homebrew/bin/podman)}"
COMPOSE_FILE="$(dirname "$0")/../docker-compose.yml"

# 1. Ensure the podman machine is running
if ! "$PODMAN" machine inspect --format '{{.State}}' 2>/dev/null | grep -q "running"; then
  echo "[ensure-observability] Starting podman machine..."
  "$PODMAN" machine start 2>&1 || true
  # Wait for the API socket to appear
  for i in $(seq 1 30); do
    "$PODMAN" info >/dev/null 2>&1 && break
    sleep 1
  done
fi

# 2. Bring up the compose stack
echo "[ensure-observability] Starting observability containers..."
"$PODMAN" compose -f "$COMPOSE_FILE" up -d 2>&1

# 3. Verify — match both Compose v1 (mitzo_svc_1) and v2 (mitzo-svc-1) naming
for svc in jaeger loki grafana mlflow; do
  # Filter matches any container whose name contains the service name
  container=$("$PODMAN" ps --filter "name=mitzo.*${svc}" --format '{{.Names}}' 2>/dev/null | head -1)
  if [ -n "$container" ]; then
    echo "[ensure-observability] $container: running"
  else
    echo "[ensure-observability] mitzo_${svc}: FAILED TO START" >&2
  fi
done
