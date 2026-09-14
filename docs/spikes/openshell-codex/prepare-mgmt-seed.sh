#!/usr/bin/env bash
set -euo pipefail

source_repo="${1:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR [RUNTIME_BASE_COMMIT]}"
output_root="${2:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR [RUNTIME_BASE_COMMIT]}"
output_parent="$(dirname "$output_root")"
output_name="$(basename "$output_root")"

test "${source_repo#/}" != "$source_repo" || { echo 'source must be absolute' >&2; exit 2; }
test "${output_root#/}" != "$output_root" || { echo 'output must be absolute' >&2; exit 2; }
git -C "$source_repo" rev-parse --is-inside-work-tree >/dev/null
starting_commit="$(git -C "$source_repo" rev-parse --verify 'HEAD^{commit}')"
runtime_base_commit="$(git -C "$source_repo" rev-parse --verify "${3:-$starting_commit}^{commit}")"
git -C "$source_repo" merge-base --is-ancestor "$runtime_base_commit" "$starting_commit" || {
  echo 'runtime base commit must be an ancestor of the seed starting commit' >&2
  exit 2
}
test ! -e "$output_root" || { echo 'output already exists' >&2; exit 2; }
test -d "$output_parent" || { echo 'output parent does not exist' >&2; exit 2; }
build_root="$(mktemp -d "$output_parent/.${output_name}.tmp.XXXXXX")"
workspace="$build_root/mgmt"
baseline="$build_root/baseline.json"
trap 'rm -rf "$build_root"' EXIT
mkdir -p "$workspace"

safe_path() {
  case "$1" in
    .git|.git/*|*/.git|*/.git/*|.claude|.claude/*|*/.claude|*/.claude/*|.codex|.codex/*|*/.codex|*/.codex/*|.cursor|.cursor/*|*/.cursor|*/.cursor/*|.mitzo|.mitzo/*|*/.mitzo|*/.mitzo/*|.mitzo.json|*/.mitzo.json|.venv|.venv/*|*/.venv|*/.venv/*|node_modules|node_modules/*|*/node_modules|*/node_modules/*|.ssh|.ssh/*|*/.ssh|*/.ssh/*|.aws|.aws/*|*/.aws|*/.aws/*|.env*|*/.env*|.npmrc|*/.npmrc|.netrc|*/.netrc|.pypirc|*/.pypirc|credentials.json|*/credentials.json|auth.json|*/auth.json|client_secret*.json|*/client_secret*.json|*credentials*.json|*/*credentials*.json|*secret*.json|*/*secret*.json|*.token|*/*.token|*.pem|*/*.pem|*.key|*/*.key|*.p12|*/*.p12|*.pfx|*/*.pfx|id_rsa|*/id_rsa|id_ed25519|*/id_ed25519|*.sock|*/*.sock|*.log|*/*.log)
      return 1 ;;
    *) return 0 ;;
  esac
}

# Every tracked path passes the same credential/runtime filter as generated
# knowledge artifacts. Archive the immutable starting commit, never the current
# working tree, so the baseline's startingCommit identifies the seed content.
# Supplying the reviewed path list to git archive preserves modes and symlinks
# without ever materializing excluded tracked files in the seed.
tracked_paths=()
while IFS= read -r -d '' path; do
  safe_path "$path" && tracked_paths+=("$path")
done < <(git -C "$source_repo" ls-tree --full-tree -r -z --name-only "$starting_commit")
if test "${#tracked_paths[@]}" -gt 0; then
  git -C "$source_repo" archive "$starting_commit" -- "${tracked_paths[@]}" | tar -x -C "$workspace"
fi

# A tracked symlink could redirect a later working-tree overlay outside the seed.
# Symlinks are not required by the reviewed MGMT runtime, so reject them before
# any overlay copy and check again after overlays are materialized.
test -z "$(find "$workspace" -type l -print -quit)" || {
  echo 'unsafe symlink in tracked seed' >&2
  exit 3
}

# memory/manifest is deliberately gitignored. These four JSON artifacts are the
# complete output set of memory/scripts/build_index.py and are the only ignored
# files permitted from the working tree. Keeping this allowlist explicit prevents
# a newly ignored secret, cache, or database from entering a future sandbox.
manifest_files=(index.json wikilinks.json by_type.json by_tag.json)
for file in "${manifest_files[@]}"; do
  source_manifest="$source_repo/memory/manifest/$file"
  test -f "$source_manifest" && test ! -L "$source_manifest" || {
    echo "required rebuilt memory manifest is missing or unsafe: $file" >&2
    exit 3
  }
  python3 -c '
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
try:
    value = json.loads(path.read_text())
except (OSError, ValueError) as error:
    raise SystemExit(f"invalid generated memory manifest {path.name}: {error}")
expected = {
    "index.json": "memories",
    "wikilinks.json": "forward_links",
    "by_type.json": "types",
    "by_tag.json": "tags",
}[path.name]
if not isinstance(value, dict) or expected not in value:
    raise SystemExit(f"inconsistent generated memory manifest {path.name}: missing {expected}")
' "$source_manifest"
  install -m 0644 "$source_manifest" "$workspace/memory/manifest/$file"
done

test -z "$(find "$workspace" -type l -print -quit)" || {
  echo 'unsafe symlink in seed overlay' >&2
  exit 3
}

# Fail closed if archive-tool option semantics or a later edit reintroduces a
# host/runtime surface. In particular, .mitzo.json can contain absolute paths
# to repositories outside this seed.
for forbidden in .git .claude .codex .cursor .mitzo .mitzo.json .venv node_modules; do
  test ! -e "$workspace/$forbidden" || {
    echo "unsafe seed path survived: $forbidden" >&2
    exit 3
  }
done
test -z "$(find "$workspace" -type d \( -name .venv -o -name node_modules \) -print -quit)" || {
  echo 'unsafe nested dependency directory survived' >&2
  exit 3
}
test -z "$(find "$workspace" \( -name '.env*' -o -name .npmrc -o -name .netrc -o -name .pypirc -o -name .ssh -o -name .aws -o -name credentials.json -o -name auth.json -o -name 'client_secret*.json' -o -name '*credentials*.json' -o -name '*secret*.json' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.token' -o -name id_rsa -o -name id_ed25519 \) -print -quit)" || {
  echo 'unsafe credential path survived' >&2
  exit 3
}

# Create a fresh portable repository rather than copying the host's .git data.
# This gives the isolated task ordinary diff/commit semantics without access to
# host worktrees, hooks, remotes, credential helpers, or repository config.
git -C "$workspace" init -q
git -C "$workspace" config user.name 'Mitzo Sandbox'
git -C "$workspace" config user.email 'sandbox@mitzo.invalid'
git -C "$workspace" add --all
git -C "$workspace" -c commit.gpgsign=false commit -q -m 'chore: seed isolated MGMT workspace'

SOURCE_REPO="$source_repo" WORKSPACE="$workspace" BASELINE="$baseline" STARTING_COMMIT="$starting_commit" RUNTIME_BASE_COMMIT="$runtime_base_commit" python3 - <<'PY'
import hashlib, json, os, pathlib
source = pathlib.Path(os.environ['SOURCE_REPO'])
workspace = pathlib.Path(os.environ['WORKSPACE'])
entries = {}
for path in sorted(p for p in workspace.rglob('*') if p.is_file() and not p.is_symlink()):
    rel = path.relative_to(workspace).as_posix()
    entries[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
payload = {
    'source': str(source),
    'startingCommit': os.environ['STARTING_COMMIT'],
    'runtimeBaseCommit': os.environ['RUNTIME_BASE_COMMIT'],
    'files': entries,
    'saveBack': 'not-implemented',
}
pathlib.Path(os.environ['BASELINE']).write_text(json.dumps(payload, indent=2) + '\n')
PY

# The versioned destination is not visible until its contents, portable Git
# repository, and baseline have all been created and validated. The mgmt updater
# owns switching its separate `current` symlink after this script returns.
mv "$build_root" "$output_root"
trap - EXIT
workspace="$output_root/mgmt"

printf 'MGMT_SEED_PREPARED files=%s bytes=%s\n' \
  "$(find "$workspace" -type f | wc -l | tr -d ' ')" \
  "$(du -sk "$workspace" | awk '{print $1 * 1024}')"
