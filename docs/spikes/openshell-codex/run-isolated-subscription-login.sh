#!/usr/bin/env bash
set -euo pipefail

# Attended login for the isolated PR #1 gateway only. The explicit endpoint and
# isolated XDG paths prevent this command from reading or changing the default
# OpenShell gateway registration.
CLI=/private/tmp/openshell-codex-oauth-review/target/debug/openshell
ISOLATED_ROOT=/private/tmp/openshell-codex-oauth-isolated-state
ENDPOINT='http://[::1]:18670'

test -x "$CLI"
mkdir -p "$ISOLATED_ROOT/config"

export XDG_CONFIG_HOME="$ISOLATED_ROOT/config"
export XDG_STATE_HOME="$ISOLATED_ROOT"

"$CLI" --gateway-endpoint "$ENDPOINT" --gateway-insecure status
exec "$CLI" \
  --gateway-endpoint "$ENDPOINT" \
  --gateway-insecure \
  provider login \
  --type codex-subscription \
  --name mitzo-personal-subscription
