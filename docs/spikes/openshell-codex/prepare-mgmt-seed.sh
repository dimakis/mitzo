#!/usr/bin/env bash
set -euo pipefail

source_repo="${1:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR [RUNTIME_BASE_COMMIT]}"
output_root="${2:?usage: prepare-mgmt-seed.sh SOURCE_REPO OUTPUT_DIR [RUNTIME_BASE_COMMIT]}"
output_parent="$(dirname "$output_root")"
output_name="$(basename "$output_root")"
lock_file="$output_parent/.${output_name}.lock"
lock_status="$output_parent/.${output_name}.lock-status.$$"
build_root=''
runtime_projection_dir=''
lock_pid=''

cleanup() {
  test -z "$build_root" || rm -rf "$build_root"
  test -z "$runtime_projection_dir" || rm -rf "$runtime_projection_dir"
  test -z "$lock_pid" || kill "$lock_pid" 2>/dev/null || true
  test -z "$lock_pid" || wait "$lock_pid" 2>/dev/null || true
  rm -f "$lock_status"
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
# The lock helper watches its original coordinating shell at the kernel level:
# kqueue on macOS and PR_SET_PDEATHSIG on Linux. This does not leak through
# build subprocesses, so SIGKILL of the updater releases flock immediately.
python3 - "$lock_file" "$lock_status" <<'PY' &
import ctypes, fcntl, os, pathlib, select, signal, sys

parent_pid = os.getppid()
if sys.platform == "darwin":
    watcher = select.kqueue()
    watcher.control([select.kevent(
        parent_pid,
        filter=select.KQ_FILTER_PROC,
        flags=select.KQ_EV_ADD,
        fflags=select.KQ_NOTE_EXIT,
    )], 0, 0)
    def wait_for_parent_exit():
        watcher.control(None, 1, None)
elif sys.platform.startswith("linux"):
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG failed")
    if os.getppid() != parent_pid:
        raise SystemExit("parent exited before lock ownership was established")
    def wait_for_parent_exit():
        signal.pause()
else:
    raise SystemExit(f"unsupported platform for parent-bound lock: {sys.platform}")

lock_path = pathlib.Path(sys.argv[1])
status_path = pathlib.Path(sys.argv[2])
def write_status(value):
    temporary = status_path.with_name(f'{status_path.name}.tmp')
    temporary.write_text(value)
    os.replace(temporary, status_path)
try:
    handle = lock_path.open('a+')
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    write_status('busy\n')
    raise SystemExit(0)
except OSError as error:
    write_status(f'error:{error}\n')
    raise SystemExit(1)
write_status('locked\n')
# The helper exits when its updater process exits, and closing this process
# closes the OS-managed advisory lock.
wait_for_parent_exit()
PY
lock_pid="$!"
for _ in $(seq 1 50); do
  test -e "$lock_status" && break
  sleep 0.1
done
lock_result="$(test -f "$lock_status" && tr -d '\n' < "$lock_status" || true)"
case "$lock_result" in
  locked) ;;
  busy)
    wait "$lock_pid" 2>/dev/null || true
    lock_pid=''
    rm -f "$lock_status"
    echo 'another seed publisher is already preparing this versioned output' >&2
    exit 2
    ;;
  *)
    # A delayed helper can acquire the lock after this coordinator has given
    # up. Terminate it before waiting: otherwise its parent-death watch waits
    # for us while we wait for it, wedging this publisher indefinitely.
    kill "$lock_pid" 2>/dev/null || true
    wait "$lock_pid" 2>/dev/null || true
    lock_pid=''
    rm -f "$lock_status"
    echo 'could not acquire an OS-managed seed publication lock' >&2
    exit 2
    ;;
esac
trap cleanup EXIT
test ! -e "$output_root" || { echo 'output already exists' >&2; exit 2; }
build_root="$(mktemp -d "$output_parent/.${output_name}.tmp.XXXXXX")"
workspace="$build_root/mgmt"
baseline="$build_root/baseline.json"
mkdir -p "$workspace"

# Mirror Dockerfile.mgmt-runtime exactly: each historical pyproject.toml and
# uv.lock pair is copied into an otherwise empty build context, then the frozen
# `uv sync --no-dev --no-install-project` input is represented by a
# normalized no-dev export plus its effective Python constraint. This includes
# default dependency groups, sources, indexes, constraints, resolver settings,
# and locked artifacts to the extent that they alter the packages installed in
# the runtime image. A dev-only lockfile refresh whose no-dev projection is
# unchanged is intentionally compatible.
if test "$runtime_base_commit" != "$starting_commit"; then
  uv_bin="${MITZO_UV_BIN:-uv}"
  command -v "$uv_bin" >/dev/null 2>&1 || {
    echo 'runtime compatibility failed: uv is required to compare a descendant seed with its runtime base' >&2
    exit 3
  }
  runtime_projection_dir="$(mktemp -d "$output_parent/.${output_name}.runtime.XXXXXX")"
  runtime_projection() {
    local commit="$1"
    local projection_dir="$runtime_projection_dir/$commit"
    mkdir -p "$projection_dir"
    git -C "$source_repo" show "$commit:pyproject.toml" > "$projection_dir/pyproject.toml"
    git -C "$source_repo" show "$commit:uv.lock" > "$projection_dir/uv.lock"
    (
      cd "$projection_dir"
      python3 - <<'PY'
import tomllib

with open('pyproject.toml', 'rb') as handle:
    project = tomllib.load(handle).get('project')
if not isinstance(project, dict) or not isinstance(project.get('requires-python'), str):
    raise SystemExit('pyproject.toml must declare project.requires-python')
print(f"requires-python={project['requires-python']}")
PY
      UV_CACHE_DIR="$projection_dir/.uv-cache" "$uv_bin" export --frozen --no-dev --no-emit-project --no-annotate --no-header \
        | LC_ALL=C sort
    )
  }
  runtime_base_projection="$(runtime_projection "$runtime_base_commit")" || {
    echo 'runtime compatibility failed: could not compute the runtime-base uv projection' >&2
    exit 3
  }
  starting_projection="$(runtime_projection "$starting_commit")" || {
    echo 'runtime compatibility failed: could not compute the seed uv projection' >&2
    exit 3
  }
  rm -rf "$runtime_projection_dir"
  runtime_projection_dir=''
  if test "$runtime_base_projection" != "$starting_projection"; then
    echo 'runtime compatibility failed: effective no-dev uv install set changed since the runtime base commit' >&2
    exit 3
  fi
fi

# Ignored manifests are generated from the working tree. Refuse a dirty tracked
# knowledge tree so their sourceCommit marker cannot be attached to data that
# differs from the immutable startingCommit archived below.
git -C "$source_repo" diff --quiet "$starting_commit" -- memory || {
  echo 'generated memory manifests cannot attest to a dirty tracked knowledge tree' >&2
  exit 3
}

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
  # The generated set attests that MGMT rebuilt the knowledge index for this
  # commit, but its contents are never copied into a seed. Recreate the
  # published manifests from archived Markdown below so an ignored working-tree
  # artifact cannot smuggle stale fields or host data into a future sandbox.
  SOURCE_MANIFEST="$source_manifest" STARTING_COMMIT="$starting_commit" python3 - <<'PY'
import json, os
try:
    value = json.load(open(os.environ['SOURCE_MANIFEST']))
except (OSError, ValueError) as error:
    raise SystemExit(f'invalid rebuilt memory manifest: {error}')
if not isinstance(value, dict) or value.get('sourceCommit') != os.environ['STARTING_COMMIT']:
    raise SystemExit('rebuilt memory manifest does not attest to startingCommit')
PY
done

# Rebuild every published manifest from the archived tree. The ignored source
# manifests are only provenance gates; no entry data crosses the working-tree
# boundary. This mirrors build_index.py's metadata/link semantics while using a
# deterministic Git timestamp for the portable seed's `modified` field.
WORKSPACE="$workspace" SOURCE_REPO="$source_repo" STARTING_COMMIT="$starting_commit" python3 - <<'PY'
import json, os, pathlib, re, subprocess
from datetime import date, datetime
from collections import defaultdict

workspace = pathlib.Path(os.environ['WORKSPACE'])
memory_root = workspace / 'memory'
manifest = memory_root / 'manifest'
source_repo = os.environ['SOURCE_REPO']
starting = os.environ['STARTING_COMMIT']
link_pattern = re.compile(r'\[\[([^\]]+)\]\]')

def fallback_metadata(lines, path):
    result = {}
    index = 0
    known = {'name', 'description', 'type', 'date', 'tags', 'state', 'confidence'}
    while index < len(lines):
        line = lines[index]
        if not line.strip() or line.lstrip().startswith('#'):
            index += 1
            continue
        if line.startswith((' ', '\t')) or ':' not in line:
            raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
        key, value = (part.strip() for part in line.split(':', 1))
        if key not in known:
            index += 1
            while index < len(lines) and lines[index].startswith((' ', '\t')):
                index += 1
            continue
        if key == 'tags' and not value:
            tags = []
            index += 1
            while index < len(lines) and lines[index].startswith((' ', '\t')):
                item = lines[index].strip()
                if not item.startswith('- ') or not item[2:].strip():
                    raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
                tags.append(item[2:].strip().strip('\"\''))
                index += 1
            result[key] = tags
            continue
        if key == 'tags' and value.startswith('[') and value.endswith(']'):
            tags = [item.strip().strip('\"\'') for item in value[1:-1].split(',')]
            if any(not item for item in tags):
                raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
            result[key] = tags
        elif value and not value.startswith(('{', '&', '*', '|', '>')):
            result[key] = value.strip('\"\'')
        else:
            raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
        index += 1
    return result

def parse_memory(path):
    lines = path.read_text().splitlines()
    metadata, content_lines = {}, lines
    if lines and lines[0].strip() == '---':
        closing = next((i for i, line in enumerate(lines[1:], 1) if line.strip() in ('---', '...')), None)
        if closing is None:
            raise SystemExit(f'cannot verify front matter in archived memory: {path}')
        raw = '\n'.join(lines[1:closing])
        try:
            import yaml
        except ImportError:
            metadata = fallback_metadata(lines[1:closing], path)
        else:
            try:
                metadata = yaml.safe_load(raw) or {}
            except yaml.YAMLError as error:
                raise SystemExit(f'cannot verify front matter in archived memory: {path}: {error}')
        if not isinstance(metadata, dict):
            raise SystemExit(f'cannot verify front matter in archived memory: {path}')
        content_lines = lines[closing + 1:]
    content = '\n'.join(content_lines)
    relative = path.relative_to(memory_root).as_posix()
    tags = metadata.get('tags', [])
    if not isinstance(tags, (list, str)) or (isinstance(tags, list) and not all(isinstance(tag, str) for tag in tags)):
        raise SystemExit(f'cannot verify tags front matter in archived memory: {path}')
    for key in ('name', 'description', 'type', 'state', 'confidence'):
        if key in metadata and not isinstance(metadata[key], str):
            raise SystemExit(f'cannot verify {key} front matter in archived memory: {path}')
    date_value = metadata.get('date', '')
    if date_value and not isinstance(date_value, str):
        if isinstance(date_value, (date, datetime)):
            date_value = date_value.isoformat()
        else:
            raise SystemExit(f'cannot verify date front matter in archived memory: {path}')
    result = subprocess.run(
        ['git', '-C', source_repo, 'log', '-1', '--format=%cI', starting, '--', f'memory/{relative}'],
        capture_output=True, text=True, check=False,
    )
    modified = result.stdout.strip()
    if result.returncode or not modified:
        raise SystemExit(f'cannot derive archived memory timestamp: {relative}')
    wikilinks = sorted({
        target.split('#', 1)[0].split('|', 1)[0].strip()
        for target in link_pattern.findall(content)
        if target.split('#', 1)[0].split('|', 1)[0].strip()
    })
    return {
        'path': relative,
        'slug': path.stem,
        'name': metadata.get('name', path.stem),
        'description': metadata.get('description', ''),
        'type': metadata.get('type', 'unknown'),
        'date': date_value,
        'tags': tags,
        'state': metadata.get('state', ''),
        'confidence': metadata.get('confidence', ''),
        'wikilinks': wikilinks,
        'content_preview': content[:200].replace('\n', ' '),
        'word_count': len(content.split()),
        'modified': modified,
    }

paths = []
for path in memory_root.rglob('*.md'):
    relative = path.relative_to(memory_root)
    if len(relative.parts) < 2 or relative.parts[0] in ('manifest', 'scripts') or relative.parts[0].startswith('.'):
        continue
    paths.append(path)
memories = [parse_memory(path) for path in sorted(paths)]
slug_map = {memory['slug']: memory for memory in memories}
if len(slug_map) != len(memories):
    raise SystemExit('cannot rebuild manifests with duplicate archived memory slugs')
slug_by_lower = {slug.lower(): slug for slug in slug_map}
forward, backlinks = defaultdict(list), defaultdict(list)
for memory in memories:
    for target in memory['wikilinks']:
        resolved = target if target in slug_map else slug_by_lower.get(target.lower())
        if resolved is not None:
            forward[memory['slug']].append(resolved)
            backlinks[resolved].append(memory['slug'])
types, tags = defaultdict(list), defaultdict(list)
for memory in memories:
    types[memory['type']].append(memory['slug'])
    for tag in memory['tags']:
        tags[tag].append(memory['slug'])
payloads = {
    'index.json': {'sourceCommit': starting, 'total_memories': len(memories), 'memories': memories},
    'wikilinks.json': {'sourceCommit': starting, 'forward_links': dict(forward), 'backlinks': dict(backlinks), 'total_links': sum(len(value) for value in forward.values())},
    'by_type.json': {'sourceCommit': starting, 'types': dict(types)},
    'by_tag.json': {'sourceCommit': starting, 'tags': dict(tags)},
}
for name, payload in payloads.items():
    (manifest / name).write_text(json.dumps(payload, indent=2) + '\n')
PY

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
    if not isinstance(entry.get('type', 'unknown'), str) or not isinstance(entry.get('tags', []), (list, str)):
        raise SystemExit('inconsistent index.json memory metadata')
    if isinstance(entry.get('tags', []), list) and not all(isinstance(tag, str) for tag in entry.get('tags', [])):
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
def archived_metadata(path):
    """Mirror python-frontmatter's YAML metadata for type and tags.

    When PyYAML is not available to the updater, accept only the common safe
    scalar/list subset and fail closed for richer YAML rather than treating a
    malformed value as trusted metadata. A scalar ``tags`` value stays a
    scalar: that intentionally mirrors build_index.py's current iteration
    semantics instead of silently normalizing its generated output.
    """
    lines = path.read_text().splitlines()
    if not lines or lines[0].strip() != '---':
        return 'unknown', []
    closing = next((index for index, line in enumerate(lines[1:], 1)
                    if line.strip() in ('---', '...')), None)
    if closing is None:
        raise SystemExit(f'cannot verify front matter in archived memory: {path}')
    raw = '\n'.join(lines[1:closing])
    try:
        import yaml
    except ImportError:
        metadata = {}
        front_matter = lines[1:closing]
        index = 0
        while index < len(front_matter):
            line = front_matter[index]
            if not line.strip() or line.lstrip().startswith('#'):
                index += 1
                continue
            if line.startswith((' ', '\t')) or ':' not in line:
                raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
            key, value = (part.strip() for part in line.split(':', 1))
            if key not in ('type', 'tags'):
                # Unrelated front-matter fields are recreated by the archive
                # manifest builder above; this verifier only needs type/tags.
                index += 1
                while index < len(front_matter) and front_matter[index].startswith((' ', '\t')):
                    index += 1
                continue
            if key == 'type':
                if not value or value.startswith(('[', '{', '&', '*', '|', '>')):
                    raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
                metadata[key] = value.strip('"\'')
            elif value.startswith('[') and value.endswith(']'):
                items = [item.strip().strip('"\'') for item in value[1:-1].split(',')]
                if any(not item for item in items):
                    raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
                metadata[key] = items
            elif value:
                if value.startswith(('{', '&', '*', '|', '>')):
                    raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
                metadata[key] = value.strip('"\'')
            else:
                items = []
                index += 1
                while index < len(front_matter) and front_matter[index].startswith((' ', '\t')):
                    item = front_matter[index].strip()
                    if not item.startswith('- ') or not item[2:].strip():
                        raise SystemExit(f'PyYAML is unavailable for complex front matter: {path}')
                    items.append(item[2:].strip().strip('"\''))
                    index += 1
                metadata[key] = items
                continue
            index += 1
    else:
        try:
            metadata = yaml.safe_load(raw) or {}
        except yaml.YAMLError as error:
            raise SystemExit(f'cannot verify front matter in archived memory: {path}: {error}')
    if not isinstance(metadata, dict):
        raise SystemExit(f'cannot verify front matter in archived memory: {path}')
    memory_type = metadata.get('type', 'unknown')
    tags = metadata.get('tags', [])
    if not isinstance(memory_type, str) or not isinstance(tags, (list, str)):
        raise SystemExit(f'cannot verify metadata front matter in archived memory: {path}')
    if isinstance(tags, list) and not all(isinstance(tag, str) for tag in tags):
        raise SystemExit(f'cannot verify tags front matter in archived memory: {path}')
    return memory_type, tags

for slug, entry in memory_by_slug.items():
    archived_type, archived_tags = archived_metadata(memory_root / entry['path'])
    if entry.get('type', 'unknown') != archived_type or entry.get('tags', []) != archived_tags:
        raise SystemExit('index.json type or tags do not match archived startingCommit Markdown metadata')
    expected_types.setdefault(archived_type, []).append(slug)
    for tag in archived_tags:
        expected_tags.setdefault(tag, []).append(slug)
if normalized_groups(by_type, 'types') != {key: sorted(value) for key, value in expected_types.items()}:
    raise SystemExit('by_type.json does not match archived startingCommit Markdown metadata')
if normalized_groups(by_tag, 'tags') != {key: sorted(value) for key, value in expected_tags.items()}:
    raise SystemExit('by_tag.json does not match archived startingCommit Markdown metadata')

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

# Reproduce build_index.py's resolved-link semantics from the archived Markdown,
# including anchor/display cleanup and case-insensitive slug fallback. This binds
# the graph to the archived knowledge content rather than merely checking that
# the four JSON files agree with one another.
import re
link_pattern = re.compile(r'\[\[([^\]]+)\]\]')
expected_forward = {}
slug_by_lower = {slug.lower(): slug for slug in slugs}
for slug, entry in memory_by_slug.items():
    content = (memory_root / entry['path']).read_text()
    raw_targets = {
        target.split('#', 1)[0].split('|', 1)[0].strip()
        for target in link_pattern.findall(content)
    }
    recorded_targets = entry.get('wikilinks')
    if not isinstance(recorded_targets, list) or not all(isinstance(target, str) for target in recorded_targets):
        raise SystemExit('inconsistent index.json memory wikilinks')
    if set(recorded_targets) != {target for target in raw_targets if target}:
        raise SystemExit('index.json wikilinks do not match archived startingCommit Markdown links')
    resolved = []
    for target in raw_targets:
        if not target:
            continue
        resolved_target = target if target in slugs else slug_by_lower.get(target.lower())
        if resolved_target is not None:
            resolved.append(resolved_target)
    if resolved:
        expected_forward[slug] = sorted(resolved)
if forward != expected_forward:
    raise SystemExit('wikilinks.json does not match archived startingCommit Markdown links')
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
    # The fresh portable repository is an implementation detail of seed
    # construction. Its mutable Git internals are not seed payload and must
    # never participate in the verifier's immutable content manifest.
    if rel == '.git' or rel.startswith('.git/'):
        continue
    entries[rel] = {
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'mode': format(path.stat().st_mode & 0o777, '04o'),
    }
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
cleanup
lock_pid=''
trap - EXIT
workspace="$output_root/mgmt"

printf 'MGMT_SEED_PREPARED files=%s bytes=%s\n' \
  "$(find "$workspace" -type f | wc -l | tr -d ' ')" \
  "$(du -sk "$workspace" | awk '{print $1 * 1024}')"
