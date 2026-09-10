#!/usr/bin/env bash
set -euo pipefail

mgmt_repo="${1:-/Users/dsaridak/redhat/mgmt}"
tag="${2:-localhost/mitzo-mgmt-runtime:codex-0.153.4}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
context="$(mktemp -d "${TMPDIR:-/tmp}/mitzo-mgmt-runtime.XXXXXX")"
cleanup() { rm -rf "$context"; }
trap cleanup EXIT

test -f "$mgmt_repo/pyproject.toml"
test -f "$mgmt_repo/uv.lock"
cp "$root/Dockerfile.mgmt-runtime" "$context/Dockerfile"
cp "$root/run-mitzo-app-server" "$context/run-mitzo-app-server"
cp "$mgmt_repo/pyproject.toml" "$context/pyproject.toml"
cp "$mgmt_repo/uv.lock" "$context/uv.lock"
podman build --tag "$tag" "$context"
printf 'MGMT_RUNTIME_IMAGE=%s\n' "$tag"
