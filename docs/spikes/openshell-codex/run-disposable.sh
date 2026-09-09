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
    if curl -fsS --max-time 5 https://api.github.com/zen >/dev/null 2>&1; then
      echo NEGATIVE_NETWORK=unexpected-allow
      exit 1
    fi
    echo NEGATIVE_NETWORK=pass
  '
