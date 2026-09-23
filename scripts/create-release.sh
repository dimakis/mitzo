#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

git -C "$SOURCE_ROOT" worktree add --detach "$RELEASE_DIR" "$SOURCE_COMMIT"
if [ -f "$SOURCE_ROOT/.env" ]; then
  cp "$SOURCE_ROOT/.env" "$RELEASE_DIR/.env"
  chmod 600 "$RELEASE_DIR/.env"
fi
if [ -d "$SOURCE_ROOT/certs" ]; then
  ln -s "$SOURCE_ROOT/certs" "$RELEASE_DIR/certs"
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
