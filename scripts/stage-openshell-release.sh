#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mgmt_repo="${1:?usage: stage-openshell-release.sh MGMT_REPO SEED_OUTPUT [IMAGE_TAG]}"
seed_output="${2:?usage: stage-openshell-release.sh MGMT_REPO SEED_OUTPUT [IMAGE_TAG]}"
manifest="$repo_root/infra/openshell/production-stack.lock.json"
policy="$repo_root/docs/spikes/openshell-codex/openshell-openai-api-policy.yaml"

require_clean_main() {
  local repo="$1"
  local label="$2"
  test -z "$(git -C "$repo" status --porcelain)" || {
    echo "Refusing staging: $label checkout is dirty" >&2
    exit 2
  }
  git -C "$repo" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'
  local head main
  head="$(git -C "$repo" rev-parse HEAD)"
  main="$(git -C "$repo" rev-parse origin/main)"
  test "$head" = "$main" || {
    echo "Refusing staging: $label HEAD $head is not current origin/main $main" >&2
    exit 2
  }
}

test "${mgmt_repo#/}" != "$mgmt_repo" || { echo 'MGMT_REPO must be absolute' >&2; exit 2; }
test "${seed_output#/}" != "$seed_output" || { echo 'SEED_OUTPUT must be absolute' >&2; exit 2; }
test ! -e "$seed_output" || { echo "SEED_OUTPUT already exists: $seed_output" >&2; exit 2; }
require_clean_main "$repo_root" Mitzo
require_clean_main "$mgmt_repo" MGMT

mitzo_commit="$(git -C "$repo_root" rev-parse HEAD)"
mgmt_commit="$(git -C "$mgmt_repo" rev-parse HEAD)"
mitzo_short="$(printf '%s' "$mitzo_commit" | cut -c1-8)"
mgmt_short="$(printf '%s' "$mgmt_commit" | cut -c1-8)"
release_date="${MITZO_RELEASE_DATE:-$(date -u +%Y%m%d)}"
image="${3:-localhost/mitzo-mgmt-runtime:release-${mitzo_short}-${mgmt_short}-${release_date}}"
base_image="$(node -e 'process.stdout.write(require(process.argv[1]).runtime.baseImage)' "$manifest")"
policy_digest="$(node -e 'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$policy")"

podman image exists "$image" && {
  echo "Refusing staging: image already exists: $image" >&2
  exit 2
}

npm --prefix "$repo_root" ci --prefer-offline --no-audit --no-fund
"$repo_root/docs/spikes/openshell-codex/build-mgmt-runtime.sh" "$mgmt_repo" "$image" "$base_image"
digest="$(podman image inspect "$image" --format '{{.Digest}}')"
labels="$(podman image inspect "$image" --format '{{json .Labels}}')"
LABELS="$labels" MITZO_COMMIT="$mitzo_commit" MGMT_COMMIT="$mgmt_commit" BASE_IMAGE="$base_image" node - <<'NODE'
const labels = JSON.parse(process.env.LABELS);
const expected = {
  'io.mitzo.source-commit': process.env.MITZO_COMMIT,
  'io.mitzo.mgmt-source-commit': process.env.MGMT_COMMIT,
  'io.mitzo.openshell.base-image': process.env.BASE_IMAGE,
};
for (const [key, value] of Object.entries(expected)) {
  if (labels[key] !== value) throw new Error(`image provenance mismatch: ${key}`);
}
NODE

# Observe the installed compiler and the Python actually used by the frozen
# runtime. Host Python/architecture and caller-provided hashes are not evidence.
attestation_dir="$(mktemp -d "${TMPDIR:-/tmp}/mitzo-runtime-attestation.XXXXXX")"
trap 'rm -rf "$attestation_dir"' EXIT
compiler_commit="$(podman image inspect "$image" --format '{{index .Labels "io.mitzo.knowledge-compiler-commit"}}')"
podman run --rm --network none "$image" /opt/mgmt-venv/bin/python -I \
  /usr/libexec/mitzo/attest-knowledge-runtime.py --compiler-commit "$compiler_commit" > "$attestation_dir/contract.json"
contract_field() {
  node -e 'process.stdout.write(String(require(process.argv[1])[process.argv[2]]))' "$attestation_dir/contract.json" "$1"
}
export MGMT_DYNAMIC_SEED=1
export MGMT_KNOWLEDGE_SCHEMA_VERSION="$(contract_field knowledgeSchemaVersion)"
export MGMT_KNOWLEDGE_COMPILER_SHA256="$(contract_field knowledgeCompilerSha256)"
export MGMT_KNOWLEDGE_RECIPE_SHA256="$(contract_field knowledgeRecipeSha256)"
export MGMT_RUNTIME_BASE_IMAGE="$base_image"
export MGMT_RUNTIME_TARGET_PLATFORM="$(contract_field targetPlatform)"
export MGMT_RUNTIME_TARGET_MARKER_ENVIRONMENT_B64="$(contract_field targetMarkerEnvironmentB64)"
export MGMT_RUNTIME_DEPENDENCY_PROJECTION_SHA256="$(uv run --isolated --no-project --with tomli==2.2.1 --with packaging==24.2 python -I \
  "$repo_root/docs/spikes/openshell-codex/runtime-resolution-contract.py" \
  --pyproject "$mgmt_repo/pyproject.toml" --lock "$mgmt_repo/uv.lock" \
  --base-image "$base_image" --target-platform "$MGMT_RUNTIME_TARGET_PLATFORM" \
  --target-marker-environment-b64 "$MGMT_RUNTIME_TARGET_MARKER_ENVIRONMENT_B64" --sha256)"
export MGMT_JIRA_RUNTIME_INPUTS_SHA256="$(python3 - "$mgmt_repo" <<'PYJIRA'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'jira_process'
files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ('pyproject.toml', 'uv.lock')}
print(hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
PYJIRA
)"
node --input-type=module - "$attestation_dir/contract.json" <<'NODE'
import {readFileSync,writeFileSync} from 'node:fs';
const path = process.argv[2];
const contract = JSON.parse(readFileSync(path,'utf8'));
contract.dependencyProjectionSha256 = process.env.MGMT_RUNTIME_DEPENDENCY_PROJECTION_SHA256;
contract.jiraRuntimeInputsSha256 = process.env.MGMT_JIRA_RUNTIME_INPUTS_SHA256;
writeFileSync(path, JSON.stringify(contract));
NODE
(cd "$mgmt_repo" && uv run --isolated --no-project --with PyYAML==6.0.2 python -I memory/scripts/build_index.py --attest-source)

"$repo_root/docs/spikes/openshell-codex/prepare-mgmt-seed.sh" "$mgmt_repo" "$seed_output"
BASELINE="$seed_output/baseline.json" MGMT_COMMIT="$mgmt_commit" node - <<'NODE'
const baseline = require(process.env.BASELINE);
if (baseline.startingCommit !== process.env.MGMT_COMMIT) {
  throw new Error('prepared seed provenance does not match MGMT main');
}
NODE
test ! -e "$seed_output/mgmt/.agents/skills/todo/SKILL.md" \
  && test ! -e "$seed_output/mgmt/.claude/skills/todo/SKILL.md" || {
  echo 'Refusing staging: legacy todo skill survived in prepared seed' >&2
  exit 3
}
node "$repo_root/scripts/update-openshell-release-lock.mjs" \
  "$image" "$digest" "$mitzo_commit" "$mgmt_commit" "$policy_digest" "$attestation_dir/contract.json"

(
  cd "$repo_root"
  ./node_modules/.bin/vitest run \
    server/__tests__/openshell-production-config.test.ts \
    server/__tests__/openshell-runtime-image.test.ts
  npm run build:server
  git diff --check
)

printf 'OPEN_SHELL_RELEASE_STAGED=pass\n'
printf 'MITZO_COMMIT=%s\n' "$mitzo_commit"
printf 'MGMT_COMMIT=%s\n' "$mgmt_commit"
printf 'RUNTIME_IMAGE=%s\n' "$image"
printf 'RUNTIME_DIGEST=%s\n' "$digest"
printf 'POLICY_DIGEST=%s\n' "$policy_digest"
printf 'PREPARED_SEED=%s/mgmt\n' "$seed_output"
printf 'NEXT_STEP=review and merge the generated stack-lock diff; do not deploy this checkout\n'
