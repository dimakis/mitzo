#!/usr/bin/env bash
set -euo pipefail

mgmt_repo="${1:?usage: build-mgmt-runtime.sh MGMT_REPO OUTPUT_TAG BASE_IMAGE@sha256:DIGEST}"
tag="${2:?usage: build-mgmt-runtime.sh MGMT_REPO OUTPUT_TAG BASE_IMAGE@sha256:DIGEST}"
base_image="${3:?usage: build-mgmt-runtime.sh MGMT_REPO OUTPUT_TAG BASE_IMAGE@sha256:DIGEST}"

if [[ ! "$base_image" =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
  echo 'base image must use an immutable @sha256 digest' >&2
  exit 2
fi
tag_component="${tag##*/}"
case "$tag_component" in
  *:*) ;;
  *)
    echo 'output image must include an explicit unique tag' >&2
    exit 2
    ;;
esac
tag_value="${tag_component##*:}"
case "$tag_value" in
  ''|latest|dev)
    echo 'output tag must be unique; latest and dev are forbidden' >&2
    exit 2
    ;;
esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$root/../../.." && pwd)"
mitzo_source_commit="$(git -C "$repo_root" rev-parse HEAD)"
mgmt_source_commit="$(git -C "$mgmt_repo" rev-parse HEAD)"
context="$(mktemp -d "${TMPDIR:-/tmp}/mitzo-mgmt-runtime.XXXXXX")"
cleanup() { rm -rf "$context"; }
trap cleanup EXIT

test -f "$mgmt_repo/pyproject.toml"
test -f "$mgmt_repo/uv.lock"
cp "$root/Dockerfile.mgmt-runtime" "$context/Dockerfile"
cp "$root/run-mitzo-app-server" "$context/run-mitzo-app-server"
cp "$root/run-mitzo-subscription-app-server" "$context/run-mitzo-subscription-app-server"
cp "$root/initialize-mitzo-workspace" "$context/initialize-mitzo-workspace"
cp "$root/compile-mgmt-context.mjs" "$context/compile-mgmt-context.mjs"
cp "$root/mitzo-checkpoint.py" "$context/mitzo-checkpoint.py"
mkdir -p "$context/contexgin/dist"
cp "$repo_root/node_modules/contexgin/package.json" "$context/contexgin/package.json"
cp -R "$repo_root/node_modules/contexgin/dist/." "$context/contexgin/dist/"
cp "$mgmt_repo/pyproject.toml" "$context/pyproject.toml"
cp "$mgmt_repo/uv.lock" "$context/uv.lock"
podman build --pull=never \
  --build-arg "OPENSHELL_BASE_IMAGE=$base_image" \
  --build-arg "MITZO_SOURCE_COMMIT=$mitzo_source_commit" \
  --build-arg "MGMT_SOURCE_COMMIT=$mgmt_source_commit" \
  --tag "$tag" "$context"
image_id="$(podman image inspect "$tag" --format '{{.Id}}')"
printf 'MGMT_RUNTIME_IMAGE=%s\n' "$tag"
printf 'MGMT_RUNTIME_IMAGE_ID=%s\n' "$image_id"
printf 'OPENSHELL_BASE_IMAGE=%s\n' "$base_image"
printf 'MITZO_SOURCE_COMMIT=%s\n' "$mitzo_source_commit"
printf 'MGMT_SOURCE_COMMIT=%s\n' "$mgmt_source_commit"
