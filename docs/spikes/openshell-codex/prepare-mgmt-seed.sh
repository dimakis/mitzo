#!/usr/bin/env bash
set -euo pipefail

source_repo="${1:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR}"
output_root="${2:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR}"
workspace="$output_root/mgmt"
baseline="$output_root/baseline.json"

test "${source_repo#/}" != "$source_repo" || { echo 'source must be absolute' >&2; exit 2; }
test "${output_root#/}" != "$output_root" || { echo 'output must be absolute' >&2; exit 2; }
git -C "$source_repo" rev-parse --is-inside-work-tree >/dev/null
test ! -e "$output_root" || { echo 'output already exists' >&2; exit 2; }
mkdir -p "$workspace"

safe_path() {
  case "$1" in
    .git|.git/*|*/.git|*/.git/*|.claude|.claude/*|*/.claude|*/.claude/*|.codex|.codex/*|*/.codex|*/.codex/*|.cursor|.cursor/*|*/.cursor|*/.cursor/*|.mitzo|.mitzo/*|*/.mitzo|*/.mitzo/*|.mitzo.json|*/.mitzo.json|.venv|.venv/*|*/.venv|*/.venv/*|node_modules|node_modules/*|*/node_modules|*/node_modules/*|.ssh|.ssh/*|*/.ssh|*/.ssh/*|.aws|.aws/*|*/.aws|*/.aws/*|.env*|*/.env*|.npmrc|*/.npmrc|.netrc|*/.netrc|.pypirc|*/.pypirc|credentials.json|*/credentials.json|auth.json|*/auth.json|client_secret*.json|*/client_secret*.json|*credentials*.json|*/*credentials*.json|*secret*.json|*/*secret*.json|*.token|*/*.token|*.pem|*/*.pem|*.key|*/*.key|*.p12|*/*.p12|*.pfx|*/*.pfx|id_rsa|*/id_rsa|id_ed25519|*/id_ed25519|*.sock|*/*.sock|*.log|*/*.log)
      return 1 ;;
    *) return 0 ;;
  esac
}

# Every tracked path passes the same credential/runtime filter as overlays.
# Supplying the reviewed path list to git archive preserves modes and symlinks
# without ever materializing excluded tracked files in the seed.
tracked_paths=()
while IFS= read -r -d '' path; do
  safe_path "$path" && tracked_paths+=("$path")
done < <(git -C "$source_repo" ls-tree -rz --name-only HEAD)
if test "${#tracked_paths[@]}" -gt 0; then
  git -C "$source_repo" archive HEAD -- "${tracked_paths[@]}" | tar -x -C "$workspace"
fi

# Overlay modified and untracked task content, but never the credential/runtime
# surfaces above. Deletions are reflected in the isolated copy only.
while IFS= read -r -d '' path; do
  safe_path "$path" || continue
  if test -e "$source_repo/$path" || test -L "$source_repo/$path"; then
    mkdir -p "$workspace/$(dirname "$path")"
    cp -a "$source_repo/$path" "$workspace/$path"
  else
    rm -f "$workspace/$path"
  fi
done < <(
  {
    git -C "$source_repo" diff --name-only -z HEAD
    git -C "$source_repo" ls-files --others --exclude-standard -z
  } | sort -zu
)

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
test -z "$(find "$workspace" \( -name '.env*' -o -name .npmrc -o -name .netrc -o -name .pypirc -o -name .ssh -o -name .aws -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.token' \) -print -quit)" || {
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

SOURCE_REPO="$source_repo" WORKSPACE="$workspace" BASELINE="$baseline" python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess
source = pathlib.Path(os.environ['SOURCE_REPO'])
workspace = pathlib.Path(os.environ['WORKSPACE'])
entries = {}
for path in sorted(p for p in workspace.rglob('*') if p.is_file() and not p.is_symlink()):
    rel = path.relative_to(workspace).as_posix()
    entries[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
payload = {
    'source': str(source),
    'startingCommit': subprocess.check_output(
        ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True
    ).strip(),
    'files': entries,
    'saveBack': 'not-implemented',
}
pathlib.Path(os.environ['BASELINE']).write_text(json.dumps(payload, indent=2) + '\n')
PY

printf 'MGMT_SEED_PREPARED files=%s bytes=%s\n' \
  "$(find "$workspace" -type f | wc -l | tr -d ' ')" \
  "$(du -sk "$workspace" | awk '{print $1 * 1024}')"
