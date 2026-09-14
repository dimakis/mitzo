#!/usr/bin/env bash
set -euo pipefail

source_repo="${1:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR [RUNTIME_BASE_COMMIT]}"
output_root="${2:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR [RUNTIME_BASE_COMMIT]}"
output_parent="$(dirname "$output_root")"
output_name="$(basename "$output_root")"
lock_dir="$output_parent/.${output_name}.lock"
build_root=''
lock_acquired=0

cleanup() {
  test -z "$build_root" || rm -rf "$build_root"
  test "$lock_acquired" -eq 0 || rmdir "$lock_dir" 2>/dev/null || true
}

test "${source_repo#/}" != "$source_repo" || { echo 'source must be absolute' >&2; exit 2; }
test "${output_root#/}" != "$output_root" || { echo 'output must be absolute' >&2; exit 2; }
git -C "$source_repo" rev-parse --is-inside-work-tree >/dev/null
starting_commit="$(git -C "$source_repo" rev-parse --verify 'HEAD^{commit}')"
runtime_base_commit="$(git -C "$source_repo" rev-parse --verify "${3:-$starting_commit}^{commit}")"
git -C "$source_repo" merge-base --is-ancestor "$runtime_base_commit" "$starting_commit" || {
  echo 'runtime base commit must be an ancestor of the seed starting commit' >&2
  exit 2
}
test -d "$output_parent" || { echo 'output parent does not exist' >&2; exit 2; }
mkdir "$lock_dir" 2>/dev/null || {
  echo 'another seed publisher is already preparing this versioned output' >&2
  exit 2
}
lock_acquired=1
trap cleanup EXIT
test ! -e "$output_root" || { echo 'output already exists' >&2; exit 2; }
build_root="$(mktemp -d "$output_parent/.${output_name}.tmp.XXXXXX")"
workspace="$build_root/mgmt"
baseline="$build_root/baseline.json"
mkdir -p "$workspace"

# A knowledge-only seed may reuse the pinned runtime only when its runtime
# dependency inputs are unchanged. This intentionally ignores dev dependencies
# and build-system metadata, matching mgmt's updater policy exactly.
git -C "$source_repo" diff --quiet "$runtime_base_commit" "$starting_commit" -- uv.lock || {
  echo 'runtime compatibility failed: uv.lock changed since the runtime base commit' >&2
  exit 3
}
python3 - "$source_repo" "$runtime_base_commit" "$starting_commit" <<'PY'
import subprocess, sys, tomllib

repo = sys.argv[1]
base = sys.argv[2]
starting = sys.argv[3]

def runtime_inputs(commit):
    try:
        raw = subprocess.check_output(
            ['git', '-C', repo, 'show', f'{commit}:pyproject.toml'], text=True
        )
        parsed = tomllib.loads(raw)
        project = parsed['project']
        requires_python = project['requires-python']
        dependencies = project['dependencies']
    except (KeyError, OSError, subprocess.CalledProcessError, tomllib.TOMLDecodeError) as error:
        raise SystemExit(f'cannot read runtime dependency inputs at {commit}: {error}')
    if not isinstance(requires_python, str) or not all(isinstance(item, str) for item in dependencies):
        raise SystemExit(f'invalid runtime dependency inputs at {commit}')
    return requires_python, dependencies

if runtime_inputs(base) != runtime_inputs(starting):
    raise SystemExit(
        'runtime compatibility failed: pyproject.toml project.requires-python or project.dependencies changed since the runtime base commit'
    )
PY

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
source_repo_resolved="$(cd "$source_repo" && pwd -P)"
source_memory="$source_repo/memory"
source_manifest_dir="$source_memory/manifest"
for path in "$source_memory" "$source_manifest_dir"; do
  test -d "$path" && test ! -L "$path" || {
    echo "required memory manifest parent is missing or unsafe: $path" >&2
    exit 3
  }
  resolved_path="$(cd "$path" && pwd -P)"
  case "$resolved_path/" in
    "$source_repo_resolved/"*) ;;
    *)
      echo "required memory manifest parent escapes the source repository: $path" >&2
      exit 3
      ;;
  esac
done
manifest_files=(index.json wikilinks.json by_type.json by_tag.json)
for file in "${manifest_files[@]}"; do
  source_manifest="$source_manifest_dir/$file"
  test -f "$source_manifest" && test ! -L "$source_manifest" || {
    echo "required rebuilt memory manifest is missing or unsafe: $file" >&2
    exit 3
  }
  install -m 0644 "$source_manifest" "$workspace/memory/manifest/$file"
done

# The manifests are built after the knowledge commit, then copied from the
# working tree. Their explicit sourceCommit marker binds every artifact to the
# archived startingCommit. Validate their schema, source paths, indexes, and
# graph inverse before publishing so stale or cross-tree artifacts fail closed.
WORKSPACE="$workspace" STARTING_COMMIT="$starting_commit" python3 - <<'PY'
import json, os, pathlib

workspace = pathlib.Path(os.environ['WORKSPACE'])
starting = os.environ['STARTING_COMMIT']
manifest = workspace / 'memory' / 'manifest'

def load(name):
    path = manifest / name
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise SystemExit(f'invalid generated memory manifest {name}: {error}')
    if not isinstance(value, dict) or value.get('sourceCommit') != starting:
        raise SystemExit(f'generated memory manifest {name} does not attest to startingCommit')
    return value

index = load('index.json')
links = load('wikilinks.json')
by_type = load('by_type.json')
by_tag = load('by_tag.json')
memories = index.get('memories')
if not isinstance(memories, list) or index.get('total_memories') != len(memories):
    raise SystemExit('inconsistent index.json memories or total_memories')

memory_root = workspace / 'memory'
expected_paths = set()
for candidate in memory_root.rglob('*.md'):
    relative = candidate.relative_to(memory_root)
    if len(relative.parts) < 2:
        continue
    top_level = relative.parts[0]
    if top_level in ('manifest', 'scripts') or top_level.startswith('.'):
        continue
    expected_paths.add(relative.as_posix())
paths = set()
slugs = set()
memory_by_slug = {}
for entry in memories:
    if not isinstance(entry, dict):
        raise SystemExit('inconsistent index.json memory entry')
    path = entry.get('path')
    slug = entry.get('slug')
    if not isinstance(path, str) or not isinstance(slug, str) or pathlib.PurePosixPath(path).stem != slug:
        raise SystemExit('inconsistent index.json memory path or slug')
    if path in paths or slug in slugs:
        raise SystemExit('inconsistent index.json duplicate memory path or slug')
    if not isinstance(entry.get('type', 'unknown'), str) or not isinstance(entry.get('tags', []), list):
        raise SystemExit('inconsistent index.json memory metadata')
    if not all(isinstance(tag, str) for tag in entry.get('tags', [])):
        raise SystemExit('inconsistent index.json memory tags')
    paths.add(path)
    slugs.add(slug)
    memory_by_slug[slug] = entry
if paths != expected_paths:
    raise SystemExit('generated index.json does not match archived startingCommit memory paths')

def normalized_groups(value, key):
    groups = value.get(key)
    if not isinstance(groups, dict) or not all(
        isinstance(group, str) and isinstance(items, list) and all(isinstance(item, str) for item in items)
        for group, items in groups.items()
    ):
        raise SystemExit(f'inconsistent generated memory manifest {key}')
    return {group: sorted(items) for group, items in groups.items()}

expected_types = {}
expected_tags = {}
for slug, entry in memory_by_slug.items():
    expected_types.setdefault(entry.get('type', 'unknown'), []).append(slug)
    for tag in entry.get('tags', []):
        expected_tags.setdefault(tag, []).append(slug)
if normalized_groups(by_type, 'types') != {key: sorted(value) for key, value in expected_types.items()}:
    raise SystemExit('by_type.json does not match index.json')
if normalized_groups(by_tag, 'tags') != {key: sorted(value) for key, value in expected_tags.items()}:
    raise SystemExit('by_tag.json does not match index.json')

forward = normalized_groups(links, 'forward_links')
backward = normalized_groups(links, 'backlinks')
if any(source not in slugs or any(target not in slugs for target in targets) for source, targets in forward.items()):
    raise SystemExit('wikilinks.json references a memory outside index.json')
expected_backlinks = {}
for source, targets in forward.items():
    for target in targets:
        expected_backlinks.setdefault(target, []).append(source)
if backward != {key: sorted(value) for key, value in expected_backlinks.items()}:
    raise SystemExit('wikilinks.json backlinks do not invert forward_links')
if links.get('total_links') != sum(len(targets) for targets in forward.values()):
    raise SystemExit('wikilinks.json total_links does not match forward_links')
PY

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
test ! -e "$output_root" || {
  echo 'output was created while the seed was being prepared' >&2
  exit 2
}
mv "$build_root" "$output_root"
build_root=''
rmdir "$lock_dir"
lock_acquired=0
trap - EXIT
workspace="$output_root/mgmt"

printf 'MGMT_SEED_PREPARED files=%s bytes=%s\n' \
  "$(find "$workspace" -type f | wc -l | tr -d ' ')" \
  "$(du -sk "$workspace" | awk '{print $1 * 1024}')"
