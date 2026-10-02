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
schema_container=""
cleanup() {
  if [ -n "$schema_container" ]; then podman rm -f "$schema_container" >/dev/null 2>&1 || true; fi
  rm -rf "$context"
}
trap cleanup EXIT

test -f "$mgmt_repo/pyproject.toml"
test -f "$mgmt_repo/uv.lock"
test -f "$mgmt_repo/jira_process/pyproject.toml"
test -f "$mgmt_repo/jira_process/uv.lock"
cp "$root/Dockerfile.mgmt-runtime" "$context/Dockerfile"
cp "$root/runtime-codex-version" "$context/runtime-codex-version"
cp "$root/run-mitzo-app-server" "$context/run-mitzo-app-server"
cp "$root/run-mitzo-subscription-app-server" "$context/run-mitzo-subscription-app-server"
cp "$root/initialize-mitzo-workspace" "$context/initialize-mitzo-workspace"
cp "$root/run-mgmt-notebook" "$context/run-mgmt-notebook"
cp "$root/compile-mgmt-context.mjs" "$context/compile-mgmt-context.mjs"
cp "$root/mitzo-checkpoint.py" "$context/mitzo-checkpoint.py"
cp "$root/knowledge-write-scope.c" "$context/knowledge-write-scope.c"
# Build from the exact reviewed source, never ambient node_modules bytes.
compiler_commit="$(node --input-type=module -e 'import fs from "node:fs"; const pin=JSON.parse(fs.readFileSync(process.argv[1])).dependencies.contexgin; const match=/^github:dimakis\/contexgin#([a-f0-9]{40})$/.exec(pin); if(!match) throw new Error("ContexGin must be commit-pinned"); process.stdout.write(match[1]);' "$repo_root/package.json")"
compiler_repo="$context/compiler.git"
git init --bare --quiet "$compiler_repo"
git -C "$compiler_repo" fetch --quiet --no-tags https://github.com/dimakis/contexgin.git "$compiler_commit"
mkdir -p "$context/compiler_source" "$context/contexgin/dist"
git -C "$compiler_repo" archive "$compiler_commit" | tar -x -C "$context/compiler_source"
(cd "$context/compiler_source" && npm ci --ignore-scripts --no-audit --no-fund && npm run build)
cp "$context/compiler_source/package.json" "$context/compiler_source/package-lock.json" "$context/contexgin/"
cp -R "$context/compiler_source/dist/." "$context/contexgin/dist/"
cp "$repo_root/scripts/attest-knowledge-runtime.py" "$context/attest-knowledge-runtime.py"
rm -rf "$compiler_repo" "$context/compiler_source"
cp "$mgmt_repo/pyproject.toml" "$context/pyproject.toml"
cp "$mgmt_repo/uv.lock" "$context/uv.lock"
mkdir -p "$context/jira_process"
cp "$mgmt_repo/jira_process/pyproject.toml" "$context/jira_process/pyproject.toml"
cp "$mgmt_repo/jira_process/uv.lock" "$context/jira_process/uv.lock"
podman build --pull=never \
  --build-arg "OPENSHELL_BASE_IMAGE=$base_image" \
  --build-arg "MITZO_SOURCE_COMMIT=$mitzo_source_commit" \
  --build-arg "MGMT_SOURCE_COMMIT=$mgmt_source_commit" \
  --build-arg "KNOWLEDGE_COMPILER_COMMIT=$compiler_commit" \
  --tag "$tag" "$context"
codex_version="$(cat "$root/runtime-codex-version")"
test "$(podman run --rm --network none --entrypoint /usr/bin/codex "$tag" --version)" = "codex-cli $codex_version"
# Regenerate the protocol contract from this exact image, never the host CLI.
# Generation is offline and submits no model turns.
schema_container="$(podman create --network none --entrypoint /usr/bin/codex "$tag" app-server generate-json-schema --experimental --out /tmp/schema)"
podman start --attach "$schema_container"
podman cp "$schema_container:/tmp/schema" "$context/schema"
node "$repo_root/scripts/reduce-codex-contract.mjs" "$context/schema" "$codex_version" \
  "$repo_root/docs/spikes/codex-web-search-policy/app-server-contract.json"
podman rm "$schema_container" >/dev/null
schema_container=""
image_id="$(podman image inspect "$tag" --format '{{.Id}}')"
printf 'MGMT_RUNTIME_IMAGE=%s\n' "$tag"
printf 'MGMT_RUNTIME_IMAGE_ID=%s\n' "$image_id"
printf 'OPENSHELL_BASE_IMAGE=%s\n' "$base_image"
printf 'MITZO_SOURCE_COMMIT=%s\n' "$mitzo_source_commit"
printf 'MGMT_SOURCE_COMMIT=%s\n' "$mgmt_source_commit"
