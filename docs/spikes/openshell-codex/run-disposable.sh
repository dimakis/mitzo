#!/usr/bin/env bash
set -euo pipefail

name="mitzo-spike-${RANDOM}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cleanup() { openshell sandbox delete "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

openshell sandbox create --name "$name" --no-auto-providers --no-keep --no-tty \
  --policy "$root/openshell-policy.yaml" --from base -- sh -lc '
    set -eu
    mkdir -p /sandbox/workspaces/primary
    touch /sandbox/workspaces/primary/positive-fixture
    test -f /sandbox/workspaces/primary/positive-fixture
    echo POSITIVE_FILESYSTEM=pass
    curl -fsS --max-time 10 https://api.github.com/zen >/dev/null
    echo POSITIVE_NETWORK=pass
    denied="$(curl -sS --max-time 10 -X POST https://api.github.com/repos/octocat/hello-world/issues \
      -H "Content-Type: application/json" -d "{\"title\":\"spike\"}" || true)"
    printf "%s" "$denied" | grep -q policy_denied
    echo NEGATIVE_NETWORK_POLICY_DENIAL=pass
  '
