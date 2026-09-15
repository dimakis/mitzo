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
contract_python() {
  # Python 3.9/3.10 need the declared tomli compatibility parser.  uv keeps
  # that provisioning explicit rather than borrowing whichever pip happens to
  # be installed on the release host.
  if python3 -c 'import tomllib' >/dev/null 2>&1 || python3 -c 'import tomli' >/dev/null 2>&1; then
    python3 "$@"
  else
    "${MITZO_UV_BIN:-uv}" run --no-project --with 'tomli>=2.0.1' python "$@"
  fi
}
mitzo_source_commit="$(git -C "$repo_root" rev-parse HEAD)"
mgmt_source_commit="$(git -C "$mgmt_repo" rev-parse HEAD)"
context="$(mktemp -d "${TMPDIR:-/tmp}/mitzo-mgmt-runtime.XXXXXX")"
cleanup() { rm -rf "$context"; }
trap cleanup EXIT

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
# Materialize precisely the commit named by the provenance label. Never bake a
# consistent-but-uncommitted checkout into an image labeled with HEAD.
git -C "$mgmt_repo" show "$mgmt_source_commit:pyproject.toml" > "$context/pyproject.toml"
git -C "$mgmt_repo" show "$mgmt_source_commit:uv.lock" > "$context/uv.lock"
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
# Marker selection must describe the interpreter inside the exact digest-pinned
# base image, not the Python which happens to launch this release script.
runtime_marker_environment="$(podman run --pull=never --entrypoint python "$base_image" -c '
import json, os, platform, sys
version = platform.python_version()
implementation = sys.implementation
implementation_version = platform.python_version() if implementation.name == "cpython" else version
print(json.dumps({
  "implementation_name": implementation.name,
  "implementation_version": implementation_version,
  "os_name": os.name,
  "platform_machine": platform.machine(),
  "platform_release": platform.release(),
  "platform_system": platform.system(),
  "platform_version": platform.version(),
  "platform_python_implementation": platform.python_implementation(),
  "python_full_version": version,
  "python_version": ".".join(version.split(".")[:2]),
  "sys_platform": sys.platform,
}, sort_keys=True, separators=(",", ":")))
')"
runtime_marker_environment_b64="$(printf '%s' "$runtime_marker_environment" | base64 | tr -d '\n')"
test -n "$runtime_marker_environment_b64" || {
  echo 'could not determine the target Python marker environment from the pinned base image' >&2
  exit 2
}
runtime_contract_sha256="$(contract_python "$context/runtime-resolution-contract.py" \
  --pyproject "$context/pyproject.toml" --lock "$context/uv.lock" \
  --base-image "$base_image" --target-platform "$target_platform" \
  --target-marker-environment-b64 "$runtime_marker_environment_b64" --sha256)"
podman build --pull=never \
  --build-arg "OPENSHELL_BASE_IMAGE=$base_image" \
  --build-arg "MITZO_SOURCE_COMMIT=$mitzo_source_commit" \
  --build-arg "MGMT_SOURCE_COMMIT=$mgmt_source_commit" \
  --build-arg "RUNTIME_RESOLUTION_CONTRACT_SHA256=$runtime_contract_sha256" \
  --build-arg "RUNTIME_TARGET_PLATFORM=$target_platform" \
  --build-arg "RUNTIME_TARGET_MARKER_ENVIRONMENT_B64=$runtime_marker_environment_b64" \
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
printf 'MGMT_RUNTIME_TARGET_MARKER_ENVIRONMENT_B64=%s\n' "$runtime_marker_environment_b64"
printf 'OPENSHELL_BASE_IMAGE=%s\n' "$base_image"
printf 'MITZO_SOURCE_COMMIT=%s\n' "$mitzo_source_commit"
printf 'MGMT_SOURCE_COMMIT=%s\n' "$mgmt_source_commit"
