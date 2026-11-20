#!/usr/bin/env bash
# Start the dedicated host stack; never recreate the retained legacy Mitzo pod.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PODMAN="${PODMAN:-$(command -v podman 2>/dev/null || echo /opt/homebrew/bin/podman)}"
SERVICES=(jaeger loki grafana mlflow)
CHECK_ARG=""
if [ "$#" -eq 1 ] && [ "$1" = --traces-only ]; then
  SERVICES=(jaeger)
  CHECK_ARG=--traces-only
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--traces-only]" >&2; exit 2
fi
STATE="${MITZO_OBSERVABILITY_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/mitzo-observability}"

if ! "$PODMAN" machine inspect --format '{{.State}}' 2>/dev/null | grep -qi '^running$'; then
  "$PODMAN" machine start
fi
"$PODMAN" info >/dev/null

# A populated legacy bind mount needs an explicit, data-preserving migration.
for svc in "${SERVICES[@]}"; do
  if "$PODMAN" container exists "mitzo_${svc}_1"; then
    legacy_state=$("$PODMAN" inspect --format '{{.State.Status}}' "mitzo_${svc}_1")
    if [ "$legacy_state" = running ] || ! "$PODMAN" volume exists "mitzo-${svc}-data"; then
      echo "Legacy $svc requires a data-preserving migration. Follow docs/operations/observability.md." >&2
      exit 1
    fi
  else
    status=$?
    if [ "$status" -ne 1 ]; then exit "$status"; fi
  fi
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
MITZO_OBSERVABILITY_CONFIG_DIR="$CONFIG/infra" "$PODMAN" compose -p mitzo-observability -f "$CONFIG/docker-compose.yml" up -d "${SERVICES[@]}"

# Readiness means working queries, not just live PIDs. Retry only during startup.
for attempt in {1..15}; do
  if node "$ROOT/scripts/observability-readback.mjs" ${CHECK_ARG:+"$CHECK_ARG"}; then exit 0; fi
  if [ "$attempt" -lt 15 ]; then sleep 2; fi
done
exit 1
