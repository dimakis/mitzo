#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_REMOTE="${MITZO_DEPLOY_REMOTE:-origin}"
MAIN_REF="${MITZO_MAIN_REF:-$DEPLOY_REMOTE/main}"
MANIFEST="${MITZO_RELEASE_MANIFEST:-$REPO_ROOT/release.txt}"

fail() {
  echo "DEPLOYMENT_GUARD=fail: $*" >&2
  exit 1
}

git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 ||
  fail "production must deploy from a Git worktree"
git -C "$REPO_ROOT" fetch --prune "$DEPLOY_REMOTE" \
  "+refs/heads/*:refs/remotes/$DEPLOY_REMOTE/*" ||
  fail "cannot refresh deployment remote $DEPLOY_REMOTE"

HEAD_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
MAIN_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify "$MAIN_REF")"

git -C "$REPO_ROOT" diff --quiet --ignore-submodules -- ||
  fail "tracked files differ from $HEAD_COMMIT"
git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules -- ||
  fail "the deployment index has staged changes"
if git -C "$REPO_ROOT" symbolic-ref --quiet HEAD >/dev/null; then
  fail "production must deploy from a detached release worktree"
fi
git -C "$REPO_ROOT" merge-base --is-ancestor "$MAIN_COMMIT" "$HEAD_COMMIT" ||
  fail "$HEAD_COMMIT does not contain current $MAIN_REF ($MAIN_COMMIT)"

REMOTE_REFS="$(git -C "$REPO_ROOT" for-each-ref \
  --format='%(refname:short) %(symref)' \
  --contains "$HEAD_COMMIT" \
  "refs/remotes/$DEPLOY_REMOTE" | awk 'NF == 1 { print $1 }')"
[ -n "$REMOTE_REFS" ] || fail "$HEAD_COMMIT is not published on a remote branch"
[ -f "$MANIFEST" ] || fail "release manifest is missing: $MANIFEST"

manifest_value() {
  sed -n "s/^$1=//p" "$MANIFEST" | tail -1
}

[ "$(manifest_value source_commit)" = "$HEAD_COMMIT" ] ||
  fail "release manifest source_commit does not match HEAD"
[ "$(manifest_value base_main)" = "$MAIN_COMMIT" ] ||
  fail "release manifest base_main does not match current $MAIN_REF"
[ "$(manifest_value source_tree)" = "$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')" ] ||
  fail "release manifest source_tree does not match HEAD"

echo "DEPLOYMENT_GUARD=pass"
echo "DEPLOYMENT_COMMIT=$HEAD_COMMIT"
echo "DEPLOYMENT_MAIN=$MAIN_COMMIT"
