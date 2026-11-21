#!/usr/bin/env bash
# Start the dedicated host stack; never recreate the retained legacy Mitzo pod.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PODMAN="${PODMAN:-$(command -v podman 2>/dev/null || echo /opt/homebrew/bin/podman)}"
SERVICES=(jaeger loki grafana mlflow)
CHECK_ARG=""
STOP_REQUESTED=0
for arg in "$@"; do
  case "$arg" in
    --traces-only) SERVICES=(jaeger); CHECK_ARG=--traces-only;;
    --stop) STOP_REQUESTED=1;;
    *) echo "Usage: $0 [--traces-only] [--stop]" >&2; exit 2;;
  esac
done
STATE="${MITZO_OBSERVABILITY_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/mitzo-observability}"

# Stop through the same engine, without creating storage or starting a stopped VM.
if [ "$STOP_REQUESTED" -eq 1 ]; then
  machine_state=$("$PODMAN" machine inspect --format '{{.State}}')
  if ! printf '%s\n' "$machine_state" | grep -qi '^running$'; then
    echo "Observability machine is not running; nothing to stop."
    exit 0
  fi
  "$PODMAN" compose -p mitzo-observability -f "$ROOT/docker-compose.yml" stop "${SERVICES[@]}"
  exit 0
fi

if ! "$PODMAN" machine inspect --format '{{.State}}' 2>/dev/null | grep -qi '^running$'; then
  "$PODMAN" machine start
fi
"$PODMAN" info >/dev/null

# A populated legacy bind mount needs an explicit, data-preserving migration.
for svc in "${SERVICES[@]}"; do
  for legacy_name in "mitzo_${svc}_1" "mitzo-${svc}-1"; do
    if "$PODMAN" container exists "$legacy_name"; then
      legacy_state=$("$PODMAN" inspect --format '{{.State.Status}}' "$legacy_name")
      if [ "$legacy_state" = running ] || ! "$PODMAN" volume exists "mitzo-${svc}-data"; then
        echo "Legacy $svc requires a data-preserving migration. Follow docs/operations/observability.md." >&2
        exit 1
      fi
    else
      status=$?
      if [ "$status" -ne 1 ]; then exit "$status"; fi
    fi
  done
done

for entry in jaeger:10001:10001 loki:10001:10001 grafana:472:0 mlflow:0:0; do
  IFS=: read -r svc uid gid <<< "$entry"
  if [ "${#SERVICES[@]}" -eq 1 ] && [ "$svc" != jaeger ]; then continue; fi
  if ! "$PODMAN" volume exists "mitzo-${svc}-data"; then
    "$PODMAN" volume create --uid "$uid" --gid "$gid" --label "com.mitzo.service=$svc" "mitzo-${svc}-data"
  fi
done
if ! "$PODMAN" network exists mitzo-observability; then
  "$PODMAN" network create mitzo-observability
fi
CONFIG="$(node "$ROOT/scripts/observability-config.mjs" "$STATE")"
# A dedicated project and no shared pod prevent cross-service replacement cascades.
MITZO_OBSERVABILITY_CONFIG_DIR=./infra "$PODMAN" compose -p mitzo-observability -f "$CONFIG/docker-compose.yml" up -d "${SERVICES[@]}"

# Readiness means working queries, not just live PIDs. Retry only during startup.
for attempt in {1..15}; do
  if node "$ROOT/scripts/observability-readback.mjs" ${CHECK_ARG:+"$CHECK_ARG"}; then exit 0; fi
  if [ "$attempt" -lt 15 ]; then sleep 2; fi
done
exit 1
