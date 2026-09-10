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

# The committed tree is the deterministic base. Host administrative/runtime
# directories are intentionally absent even when the source has local content.
git -C "$source_repo" archive HEAD | tar \
  --exclude='.claude' --exclude='.claude/*' \
  --exclude='.codex' --exclude='.codex/*' \
  --exclude='.cursor' --exclude='.cursor/*' \
  --exclude='.mitzo' --exclude='.mitzo/*' --exclude='.mitzo.json' \
  --exclude='.venv' --exclude='.venv/*' --exclude='*/.venv' --exclude='*/.venv/*' \
  --exclude='node_modules' --exclude='node_modules/*' \
  --exclude='*/node_modules' --exclude='*/node_modules/*' \
  -x -C "$workspace"

safe_path() {
  case "$1" in
    .git|.git/*|.claude|.claude/*|.codex|.codex/*|.cursor|.cursor/*|.mitzo|.mitzo/*|.venv|.venv/*|*/.venv|*/.venv/*|node_modules|node_modules/*|*/node_modules/*|.env|*/.env|credentials.json|*/credentials.json|auth.json|*/auth.json|client_secret*.json|*/client_secret*.json|*.token|*/*.token|*.sock|*/*.sock|*.log|*/*.log)
      return 1 ;;
    *) return 0 ;;
  esac
}

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
