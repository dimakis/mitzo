#!/bin/bash
set -euo pipefail

SOURCE_ROOT="${MITZO_SOURCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
RUNTIME_ROOT="${MITZO_RUNTIME_ROOT:-$SOURCE_ROOT}"
SOURCE_REF="${1:-HEAD}"
RELEASE_ROOT="${MITZO_RELEASE_ROOT:-$HOME/tools/mitzo-releases}"
LOCK_FILE="/tmp/com.mitzo.server.$(id -u).deploy.lock"
RELEASE_TEMP=""

mkdir -p "$RELEASE_ROOT"
if ! shlock -f "$LOCK_FILE" -p "$$"; then
  echo "Refusing release: another Mitzo deployment is active" >&2
  exit 1
fi
cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ -n "$RELEASE_TEMP" ] && [ -d "$RELEASE_TEMP" ]; then rm -rf -- "$RELEASE_TEMP"; fi
  rm -f -- "$LOCK_FILE"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

git -C "$SOURCE_ROOT" fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'
SOURCE_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify "$SOURCE_REF^{commit}")"
MAIN_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify origin/main)"
git -C "$SOURCE_ROOT" merge-base --is-ancestor "$MAIN_COMMIT" "$SOURCE_COMMIT" || {
  echo "Refusing release: $SOURCE_COMMIT does not contain origin/main $MAIN_COMMIT" >&2
  exit 1
}
REMOTE_REF="$(git -C "$SOURCE_ROOT" branch -r --contains "$SOURCE_COMMIT" | sed -n '1{s/^[[:space:]]*//;p;}')"
[ -n "$REMOTE_REF" ] || {
  echo "Refusing release: $SOURCE_COMMIT is not published on a remote branch" >&2
  exit 1
}

[ -f "$RUNTIME_ROOT/.env" ] || {
  echo "Refusing release: canonical runtime .env is missing" >&2
  exit 1
}
SHORT_COMMIT="$(printf '%s' "$SOURCE_COMMIT" | cut -c1-12)"
REF_SLUG="$(printf '%s' "$REMOTE_REF" | sed 's|^origin/||; s|[^A-Za-z0-9._-]|-|g')"
RELEASE_DIR="$RELEASE_ROOT/${REF_SLUG}-${SHORT_COMMIT}"
[ ! -e "$RELEASE_DIR" ] || {
  echo "Refusing release: target already exists: $RELEASE_DIR" >&2
  exit 1
}
RELEASE_TEMP="$(mktemp -d "$RELEASE_ROOT/.build.XXXXXX")"
BUILD_DIR="$RELEASE_TEMP/release"
FINAL_RELEASE_DIR="$RELEASE_ROOT/${REF_SLUG}-${SHORT_COMMIT}"
git clone --no-local --no-checkout "$SOURCE_ROOT" "$BUILD_DIR"
ORIGIN_URL="$(git -C "$SOURCE_ROOT" remote get-url origin)"
REMOTE_BRANCH="${REMOTE_REF#origin/}"
git -C "$BUILD_DIR" remote set-url origin "$ORIGIN_URL"
git -C "$BUILD_DIR" fetch --no-tags origin \
  "+refs/heads/$REMOTE_BRANCH:refs/remotes/origin/$REMOTE_BRANCH"
git -C "$BUILD_DIR" checkout --detach "$SOURCE_COMMIT"
# The source checkout may itself only have origin/main as a remote-tracking ref,
# which a local clone does not copy. Pin the already-fetched main commit into the
# release so the deploy-time ancestry guard remains self-contained.
git -C "$BUILD_DIR" update-ref refs/remotes/origin/main "$MAIN_COMMIT"
RELEASE_DIR="$BUILD_DIR"
cp "$RUNTIME_ROOT/.env" "$RELEASE_DIR/.env"
chmod 600 "$RELEASE_DIR/.env"

rewrite_env_value() {
    local key="$1"
    local value="$2"
    local next_env="$RELEASE_DIR/.env.next"
    awk -v key="$key" -v value="$value" \
      'index($0, key "=") == 1 { $0 = key "=" value; found = 1 } { print } END { if (!found) print key "=" value }' \
      "$RELEASE_DIR/.env" > "$next_env"
    mv "$next_env" "$RELEASE_DIR/.env"
    chmod 600 "$RELEASE_DIR/.env"
}

STACK_MANIFEST="$RELEASE_DIR/infra/openshell/production-stack.lock.json"
manifest_value() {
    node -e 'const value = process.argv[2].split(".").reduce((item, key) => item[key], require(process.argv[1])); process.stdout.write(Array.isArray(value) ? value.join(",") : String(value))' \
      "$STACK_MANIFEST" "$1"
}

rewrite_env_value MITZO_OPENSHELL_STACK_MANIFEST "$RELEASE_DIR/infra/openshell/production-stack.lock.json"
rewrite_env_value MITZO_OPENSHELL_POLICY "$RELEASE_DIR/docs/spikes/openshell-codex/openshell-openai-api-policy.yaml"
rewrite_env_value MITZO_CONNECTIONS_JIRA_PROFILE_PATH "$RELEASE_DIR/infra/openshell/providers/mitzo-jira-readonly.yaml"
rewrite_env_value MITZO_CONNECTIONS_PROBE_POLICY "$RELEASE_DIR/infra/openshell/providers/mitzo-jira-probe-policy.yaml"
rewrite_env_value MITZO_OPENSHELL_IMAGE "$(manifest_value runtime.image)"
rewrite_env_value OPENSHELL_WORKSPACE "$(manifest_value defaults.workspace)"
rewrite_env_value MITZO_OPENSHELL_WEB_SEARCH "$(manifest_value defaults.webSearch)"
rewrite_env_value MITZO_OPENSHELL_SERVICE_PROVIDERS "$(manifest_value providerPolicy.automatic)"
rewrite_env_value MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS "$(manifest_value providerPolicy.grantable)"
if [ -d "$RUNTIME_ROOT/certs" ]; then
  ln -s "$RUNTIME_ROOT/certs" "$RELEASE_DIR/certs"
fi

cat > "$RELEASE_DIR/release.txt" <<EOF
source_commit=$SOURCE_COMMIT
source_ref=$REMOTE_REF
base_main=$MAIN_COMMIT
source_tree=$(git -C "$SOURCE_ROOT" rev-parse "$SOURCE_COMMIT^{tree}")
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

(
  cd "$RELEASE_DIR"
  npm ci
  node scripts/verify-openshell-production.mjs .env
)

rewrite_env_value MITZO_OPENSHELL_STACK_MANIFEST "$FINAL_RELEASE_DIR/infra/openshell/production-stack.lock.json"
rewrite_env_value MITZO_OPENSHELL_POLICY "$FINAL_RELEASE_DIR/docs/spikes/openshell-codex/openshell-openai-api-policy.yaml"
rewrite_env_value MITZO_CONNECTIONS_JIRA_PROFILE_PATH "$FINAL_RELEASE_DIR/infra/openshell/providers/mitzo-jira-readonly.yaml"
rewrite_env_value MITZO_CONNECTIONS_PROBE_POLICY "$FINAL_RELEASE_DIR/infra/openshell/providers/mitzo-jira-probe-policy.yaml"
mv "$RELEASE_DIR" "$FINAL_RELEASE_DIR"
rmdir "$RELEASE_TEMP"
RELEASE_TEMP=""
RELEASE_DIR="$FINAL_RELEASE_DIR"

(
  cd "$RELEASE_DIR"
  ./scripts/deploy.sh
)

echo "Released $SOURCE_COMMIT from $REMOTE_REF to $RELEASE_DIR"
