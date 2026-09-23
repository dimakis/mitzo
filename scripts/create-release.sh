#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${MITZO_RUNTIME_ROOT:-$SOURCE_ROOT}"
SOURCE_REF="${1:-HEAD}"
RELEASE_ROOT="${MITZO_RELEASE_ROOT:-$HOME/tools/mitzo-releases}"

git -C "$SOURCE_ROOT" fetch --prune origin main
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

mkdir -p "$RELEASE_ROOT"
SHORT_COMMIT="$(printf '%s' "$SOURCE_COMMIT" | cut -c1-12)"
REF_SLUG="$(printf '%s' "$REMOTE_REF" | sed 's|^origin/||; s|[^A-Za-z0-9._-]|-|g')"
RELEASE_DIR="$RELEASE_ROOT/${REF_SLUG}-${SHORT_COMMIT}"
[ ! -e "$RELEASE_DIR" ] || {
  echo "Refusing release: target already exists: $RELEASE_DIR" >&2
  exit 1
}

git clone --no-local --no-checkout "$SOURCE_ROOT" "$RELEASE_DIR"
git -C "$RELEASE_DIR" checkout --detach "$SOURCE_COMMIT"
# The source checkout may itself only have origin/main as a remote-tracking ref,
# which a local clone does not copy. Pin the already-fetched main commit into the
# release so the deploy-time ancestry guard remains self-contained.
git -C "$RELEASE_DIR" update-ref refs/remotes/origin/main "$MAIN_COMMIT"
if [ -f "$RUNTIME_ROOT/.env" ]; then
  cp "$RUNTIME_ROOT/.env" "$RELEASE_DIR/.env"
  chmod 600 "$RELEASE_DIR/.env"

  rewrite_release_path() {
    local key="$1"
    local relative_path="$2"
    local next_env="$RELEASE_DIR/.env.next"
    awk -v key="$key" -v value="$RELEASE_DIR/$relative_path" \
      'index($0, key "=") == 1 { $0 = key "=" value } { print }' \
      "$RELEASE_DIR/.env" > "$next_env"
    mv "$next_env" "$RELEASE_DIR/.env"
    chmod 600 "$RELEASE_DIR/.env"
  }

  rewrite_release_path MITZO_OPENSHELL_STACK_MANIFEST infra/openshell/production-stack.lock.json
  rewrite_release_path MITZO_OPENSHELL_POLICY docs/spikes/openshell-codex/openshell-openai-api-policy.yaml
  rewrite_release_path MITZO_CONNECTIONS_JIRA_PROFILE_PATH infra/openshell/providers/mitzo-jira-readonly.yaml
  rewrite_release_path MITZO_CONNECTIONS_PROBE_POLICY infra/openshell/providers/mitzo-jira-probe-policy.yaml
fi
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
  ./scripts/deploy.sh
)

echo "Released $SOURCE_COMMIT from $REMOTE_REF to $RELEASE_DIR"
