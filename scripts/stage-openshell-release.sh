#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mgmt_repo="${1:?usage: stage-openshell-release.sh MGMT_REPO SEED_OUTPUT [IMAGE_TAG]}"
seed_output="${2:?usage: stage-openshell-release.sh MGMT_REPO SEED_OUTPUT [IMAGE_TAG]}"
manifest="$repo_root/infra/openshell/production-stack.lock.json"

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
  "$image" "$digest" "$mitzo_commit" "$mgmt_commit"

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
printf 'PREPARED_SEED=%s/mgmt\n' "$seed_output"
printf 'NEXT_STEP=review and merge the generated stack-lock diff; do not deploy this checkout\n'
