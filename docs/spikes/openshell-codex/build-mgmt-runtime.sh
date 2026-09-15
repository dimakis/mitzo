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
cp "$root/runtime-resolution-contract.py" "$context/runtime-resolution-contract.py"
mkdir -p "$context/contexgin/dist"
cp "$repo_root/node_modules/contexgin/package.json" "$context/contexgin/package.json"
cp -R "$repo_root/node_modules/contexgin/dist/." "$context/contexgin/dist/"
cp "$mgmt_repo/pyproject.toml" "$context/pyproject.toml"
cp "$mgmt_repo/uv.lock" "$context/uv.lock"
# A release is reproducible only from a reviewed, committed lock.  Never repair
# a stale lock in this disposable context: it would make the image disagree with
# the MGMT commit recorded in its provenance labels. Operators must run the
# documented migration command in the MGMT checkout, review and commit its lock,
# then invoke this builder.
(cd "$context" && UV_CACHE_DIR="$context/.uv-cache" uv lock --locked)
# This is a checked-in-lock projection, not a fresh host resolution. The
# Dockerfile validates the same immutable inputs before syncing.
target_platform="$(podman image inspect "$base_image" --format '{{.Os}}/{{.Architecture}}')"
if [[ ! "$target_platform" =~ ^[a-z0-9]+/[a-z0-9][a-z0-9._-]*$ ]]; then
  echo 'could not determine an explicit runtime target platform from the pinned base image' >&2
  exit 2
fi
runtime_contract_sha256="$(python3 "$context/runtime-resolution-contract.py" \
  --pyproject "$context/pyproject.toml" --lock "$context/uv.lock" \
  --base-image "$base_image" --target-platform "$target_platform" --sha256)"
podman build --pull=never \
  --build-arg "OPENSHELL_BASE_IMAGE=$base_image" \
  --build-arg "MITZO_SOURCE_COMMIT=$mitzo_source_commit" \
  --build-arg "MGMT_SOURCE_COMMIT=$mgmt_source_commit" \
  --build-arg "RUNTIME_RESOLUTION_CONTRACT_SHA256=$runtime_contract_sha256" \
  --build-arg "RUNTIME_TARGET_PLATFORM=$target_platform" \
  --tag "$tag" "$context"
image_id="$(podman image inspect "$tag" --format '{{.Id}}')"
# The image contains the exact canonical bytes built from the checked-in lock.
# Read it back after the build so release plumbing cannot accidentally publish a
# host-side value for a different image.
image_contract_sha256="$(podman run --rm --entrypoint /usr/bin/sha256sum "$image_id" /opt/mgmt-resolution-contract.json | awk '{print $1}')"
test "$image_contract_sha256" = "$runtime_contract_sha256" || {
  echo 'runtime image resolution contract does not match the build contract' >&2
  exit 3
}
printf 'MGMT_RUNTIME_IMAGE=%s\n' "$tag"
printf 'MGMT_RUNTIME_IMAGE_ID=%s\n' "$image_id"
printf 'MGMT_RUNTIME_DEPENDENCY_PROJECTION_SHA256=%s\n' "$runtime_contract_sha256"
printf 'MGMT_RUNTIME_BASE_IMAGE=%s\n' "$base_image"
printf 'MGMT_RUNTIME_TARGET_PLATFORM=%s\n' "$target_platform"
printf 'OPENSHELL_BASE_IMAGE=%s\n' "$base_image"
printf 'MITZO_SOURCE_COMMIT=%s\n' "$mitzo_source_commit"
printf 'MGMT_SOURCE_COMMIT=%s\n' "$mgmt_source_commit"
