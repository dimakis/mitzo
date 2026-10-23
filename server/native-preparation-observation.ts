import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  NativeFileHelperTransport,
  NativeReadAnchor,
  NativeReadIdentity,
} from './native-file-operation.js';
import type { LocalRepositoryReadEntry } from './local-repository-read-access.js';

export const nativePreparationObservationVersion = 'preparation-base-observation-v1' as const;
/** Private typed protocol bounds. Generic ReadBytes/directory limits do not change. */
export const nativePreparationObservationLimits = Object.freeze({
  requestBytes: 128 * 1024,
  witnessBytes: 8 * 1024 * 1024,
  responseBytes: 64 * 1024 * 1024,
  directories: 16 * 128 + 3,
  files: 24,
  absences: 24,
  entries: 100000,
  packedBytes: 16 * 1024 * 1024,
  configBytes: 65536,
  pointerBytes: 4096,
});
export interface NativePreparationObservationPlan {
  readonly version: typeof nativePreparationObservationVersion;
  readonly sourceAnchor: NativeReadAnchor;
  readonly gitDirectory: string;
  readonly commonAnchor: NativeReadAnchor;
  readonly deniedRoots: readonly string[];
}
export interface NativePreparationObservationScratch {
  readonly rootAnchor: NativeReadAnchor;
  readonly file_path: string;
}
export interface NativePreparationObservationWitness {
  readonly file_path: string;
  readonly identity: NativeReadIdentity;
  readonly byteLength: number;
  readonly sha256: string;
}
/** Directory coordinates are a topological trie. Full physical listing hashes
 * stay in the witness; only parser-consumed children cross into this typed view. */
export interface NativePreparationObservationData {
  readonly version: typeof nativePreparationObservationVersion;
  readonly anchors: readonly {
    readonly rootPath: string;
    readonly entry: Readonly<LocalRepositoryReadEntry>;
    readonly parentIdentity: NativeReadIdentity;
  }[];
  readonly directories: readonly {
    readonly anchor: number;
    readonly parent: number;
    readonly name: string;
    readonly entry: Readonly<LocalRepositoryReadEntry>;
    readonly parentIdentity: NativeReadIdentity;
    readonly entries: readonly Readonly<LocalRepositoryReadEntry>[];
    readonly listingSha256: string;
    readonly incomplete: boolean;
  }[];
  readonly files: readonly {
    readonly directory: number;
    readonly name: string;
    readonly purpose: 'marker' | 'config' | 'pointer' | 'packed';
    readonly entry: Readonly<LocalRepositoryReadEntry>;
    readonly bytes: string;
    readonly sha256: string;
  }[];
  readonly absent: readonly { readonly directory: number; readonly name: string }[];
}
export interface NativePreparationObservationCapture {
  readonly observation: Readonly<NativePreparationObservationData>;
  readonly witness: Readonly<NativePreparationObservationWitness>;
}
const unavailable = () => Error('Native preparation observation unavailable');
function record(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  const names = Reflect.ownKeys(value);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw unavailable();
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw unavailable();
      return [key, descriptor.value];
    }),
  );
}
const path = (value: unknown): value is string =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  resolve(value) === value &&
  !/[\0\r\n]/.test(value) &&
  Buffer.from(value).toString('utf8') === value &&
  Buffer.byteLength(value) <= 4096 &&
  value.split('/').length <= 129;
function identity(value: unknown): Readonly<NativeReadIdentity> {
  const item = record(value, ['dev', 'ino']);
  if (![item.dev, item.ino].every((part) => typeof part === 'string' && /^\d{1,32}$/.test(part)))
    throw unavailable();
  return Object.freeze({ dev: item.dev, ino: item.ino });
}
function anchor(value: unknown): Readonly<NativeReadAnchor> {
  const item = record(value, ['rootPath', 'identity']);
  if (!path(item.rootPath)) throw unavailable();
  return Object.freeze({ rootPath: item.rootPath, identity: identity(item.identity) });
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    throw unavailable();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw unavailable();
    return descriptor.value;
  });
}
function exclusions(value: unknown): readonly string[] {
  const roots = array(value, 256);
  if (roots.some((root) => !path(root)) || Buffer.byteLength(JSON.stringify(roots)) > 65536)
    throw unavailable();
  return Object.freeze(roots as string[]);
}
export function freezeNativePreparationObservationPlan(
  value: unknown,
): Readonly<NativePreparationObservationPlan> {
  const item = record(value, [
    'version',
    'sourceAnchor',
    'gitDirectory',
    'commonAnchor',
    'deniedRoots',
  ]);
  if (item.version !== nativePreparationObservationVersion || !path(item.gitDirectory))
    throw unavailable();
  return Object.freeze({
    version: nativePreparationObservationVersion,
    sourceAnchor: anchor(item.sourceAnchor),
    gitDirectory: item.gitDirectory,
    commonAnchor: anchor(item.commonAnchor),
    deniedRoots: exclusions(item.deniedRoots),
  });
}
export function freezeNativePreparationObservationScratch(
  value: unknown,
): Readonly<NativePreparationObservationScratch> {
  const item = record(value, ['rootAnchor', 'file_path']);
  const rootAnchor = anchor(item.rootAnchor);
  if (
    rootAnchor.rootPath === '/' ||
    !path(item.file_path) ||
    dirname(item.file_path) !== rootAnchor.rootPath ||
    !/^capture-\d{1,3}\.json$/.test(item.file_path.slice(rootAnchor.rootPath.length + 1))
  )
    throw unavailable();
  return Object.freeze({ rootAnchor, file_path: item.file_path });
}
export function freezeNativePreparationObservationWitness(
  value: unknown,
): Readonly<NativePreparationObservationWitness> {
  const item = record(value, ['file_path', 'identity', 'byteLength', 'sha256']);
  if (
    !path(item.file_path) ||
    !Number.isSafeInteger(item.byteLength) ||
    item.byteLength < 1 ||
    item.byteLength > nativePreparationObservationLimits.witnessBytes ||
    typeof item.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  )
    throw unavailable();
  return Object.freeze({
    file_path: item.file_path,
    identity: identity(item.identity),
    byteLength: item.byteLength,
    sha256: item.sha256,
  });
}
function entry(value: unknown): Readonly<LocalRepositoryReadEntry> {
  const item = record(value, [
    'name',
    'identity',
    'kind',
    'size',
    'mode',
    'nlink',
    'mtimeNs',
    'ctimeNs',
  ]);
  if (
    typeof item.name !== 'string' ||
    /[/\0]/.test(item.name) ||
    ['.', '..'].includes(item.name) ||
    !['file', 'directory', 'unsupported'].includes(item.kind) ||
    !['size', 'mode', 'nlink'].every((key) => Number.isSafeInteger(item[key]) && item[key] >= 0) ||
    !['mtimeNs', 'ctimeNs'].every(
      (key) => typeof item[key] === 'string' && /^\d{1,32}$/.test(item[key]),
    )
  )
    throw unavailable();
  return Object.freeze({
    ...item,
    identity: identity(item.identity),
  }) as Readonly<LocalRepositoryReadEntry>;
}
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  !/[/\0]/.test(value) &&
  !['.', '..'].includes(value) &&
  Buffer.byteLength(value) <= 4096;
/** Decode only the bounded private capture, never a public/model projection. */
export function freezeNativePreparationObservationData(
  value: unknown,
): Readonly<NativePreparationObservationData> {
  const item = record(value, ['version', 'anchors', 'directories', 'files', 'absent']);
  if (item.version !== nativePreparationObservationVersion) throw unavailable();
  const anchors = array(item.anchors, 3).map((value) => {
    const item = record(value, ['rootPath', 'entry', 'parentIdentity']);
    if (!path(item.rootPath)) throw unavailable();
    return Object.freeze({
      rootPath: item.rootPath,
      entry: entry(item.entry),
      parentIdentity: identity(item.parentIdentity),
    });
  });
  if (
    !anchors.length ||
    new Set(anchors.map((item) => item.rootPath)).size !== anchors.length ||
    anchors.some((item) => item.entry.kind !== 'directory')
  )
    throw unavailable();
  const directories = array(item.directories, nativePreparationObservationLimits.directories).map(
    (value, index) => {
      const item = record(value, [
        'anchor',
        'parent',
        'name',
        'entry',
        'parentIdentity',
        'entries',
        'listingSha256',
        'incomplete',
      ]);
      if (
        !Number.isSafeInteger(item.anchor) ||
        item.anchor < 0 ||
        item.anchor >= anchors.length ||
        !Number.isSafeInteger(item.parent) ||
        item.parent < -1 ||
        item.parent >= index ||
        (item.parent === -1 ? item.name !== '' : !name(item.name)) ||
        !sha(item.listingSha256) ||
        typeof item.incomplete !== 'boolean'
      )
        throw unavailable();
      const directoryEntry = entry(item.entry);
      if (directoryEntry.kind !== 'directory') throw unavailable();
      const entries = array(item.entries, 10000).map(entry);
      if (
        new Set(entries.map((item) => item.name)).size !== entries.length ||
        entries.some((item) => !name(item.name))
      )
        throw unavailable();
      return Object.freeze({
        anchor: item.anchor,
        parent: item.parent,
        name: item.name,
        entry: directoryEntry,
        parentIdentity: identity(item.parentIdentity),
        entries: Object.freeze(entries),
        listingSha256: item.listingSha256,
        incomplete: item.incomplete,
      });
    },
  );
  const reference = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < directories.length;
  let total = 0;
  const purposeCounts = { marker: 0, config: 0, pointer: 0, packed: 0 };
  const purposeMaximum = { marker: 1, config: 4, pointer: 18, packed: 1 };
  const fileCoordinates = new Set<string>();
  const files = array(item.files, nativePreparationObservationLimits.files).map((value) => {
    const item = record(value, ['directory', 'name', 'purpose', 'entry', 'bytes', 'sha256']);
    if (
      typeof item.purpose !== 'string' ||
      !['marker', 'config', 'pointer', 'packed'].includes(item.purpose)
    )
      throw unavailable();
    const purpose = item.purpose as 'marker' | 'config' | 'pointer' | 'packed';
    const limit =
      purpose === 'packed'
        ? nativePreparationObservationLimits.packedBytes
        : purpose === 'config'
          ? nativePreparationObservationLimits.configBytes
          : nativePreparationObservationLimits.pointerBytes;
    if (++purposeCounts[purpose] > purposeMaximum[purpose]) throw unavailable();
    if (
      !reference(item.directory) ||
      !name(item.name) ||
      typeof item.bytes !== 'string' ||
      !sha(item.sha256) ||
      item.bytes.length > Math.ceil(limit / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(item.bytes) ||
      item.bytes.length % 4 !== 0
    )
      throw unavailable();
    const coordinate = String(item.directory) + '/' + item.name;
    if (fileCoordinates.has(coordinate)) throw unavailable();
    fileCoordinates.add(coordinate);
    const bytes = Buffer.from(item.bytes, 'base64'),
      state = entry(item.entry);
    total += bytes.length;
    if (
      state.kind !== 'file' ||
      state.nlink !== 1 ||
      state.name !== item.name ||
      state.size !== bytes.length ||
      bytes.toString('base64') !== item.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== item.sha256 ||
      bytes.length > limit ||
      total > 17117184
    )
      throw unavailable();
    return Object.freeze({
      directory: item.directory,
      name: item.name,
      purpose,
      entry: state,
      bytes: item.bytes,
      sha256: item.sha256,
    });
  });
  const absent = array(item.absent, nativePreparationObservationLimits.absences).map((value) => {
    const item = record(value, ['directory', 'name']);
    if (!reference(item.directory) || !name(item.name)) throw unavailable();
    return Object.freeze({ directory: item.directory, name: item.name });
  });
  return Object.freeze({
    version: nativePreparationObservationVersion,
    anchors: Object.freeze(anchors),
    directories: Object.freeze(directories),
    files: Object.freeze(files),
    absent: Object.freeze(absent),
  });
}

/** Embedded in the existing descriptor helper; no standalone program. */
export const nativePreparationObservationPython = String.raw`
# Preparation-only, fixed physical observation. Git grammar/config semantics stay
# in the unchanged TypeScript/Git parsers. No public operation selects this view.
def preparation_observation(request):
    plan = request['observationPlan']
    scratch = request['observationScratch']
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    exclusions = plan['deniedRoots']
    version = 'preparation-base-observation-v1'
    witness_limit = 8 * 1024 * 1024
    response_limit = 64 * 1024 * 1024
    def fail():
        raise RuntimeError('Preparation observation unavailable')
    def check():
        if time.monotonic() >= deadline: fail()
    def canonical(value):
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'))
    def digest(value):
        return hashlib.sha256(canonical(value).encode('ascii')).hexdigest()
    def ident(info):
        return {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
    def state(info, name=''):
        return {'name': name, 'identity': ident(info), 'kind': 'file' if stat.S_ISREG(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'unsupported', 'size': info.st_size, 'mode': info.st_mode, 'nlink': info.st_nlink, 'mtimeNs': str(info.st_mtime_ns), 'ctimeNs': str(info.st_ctime_ns)}
    def same(info, expected):
        actual = state(info, expected['name'])
        return actual == expected
    def parts(path):
        if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or len(path.encode('utf-8')) > 4096: fail()
        value = [part for part in path.split('/') if part]
        if len(value) > 128 or any(part in ('.', '..') for part in value): fail()
        return value
    def contains(root, path):
        return path == root or path.startswith(root.rstrip('/') + '/')
    credentials = {'.ssh', '.aws', '.gnupg', '.kube', '.azure', '.gcloud', 'Keychains'}
    agents = {'.claude', '.cursor', '.codex'}
    # Negative-only equivalence: this can refuse more names, never grant or
    # canonicalize a source. Dynamic parents lack per-directory SRT name denies.
    import unicodedata
    def negative_name(name):
        return unicodedata.normalize('NFD', name).casefold()
    credential_names = {negative_name(name) for name in credentials}
    agent_names = {negative_name(name) for name in agents}
    def restricted(path):
        path_parts = parts(path)
        return any(negative_name(part) in credential_names or (negative_name(part) in agent_names and (part not in agents or index + 1 == len(path_parts) or path_parts[index + 1] != 'worktrees')) for index, part in enumerate(path_parts))
    def allowed(path):
        check()
        parts(path)
        if any(contains(root, path) for root in exclusions) or restricted(path): fail()
    if os.open not in os.supports_dir_fd or os.scandir not in os.supports_fd or not hasattr(os, 'O_NOFOLLOW'): fail()
    # Denied ancestors are refused before their lookup. No source canonicalizer.
    original = {plan['sourceAnchor']['rootPath']: plan['sourceAnchor']['identity'], plan['commonAnchor']['rootPath']: plan['commonAnchor']['identity']}
    known = {}
    known_parents = {}
    def open_directory(path, expected=None):
        allowed(path)
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if '/' in original and ident(os.fstat(directory)) != original['/']: fail()
            prefix = ''
            for part in parts(path):
                check()
                prefix += '/' + part
                # The WHOLE requested path was statically restricted above.
                # A .codex/worktrees ancestor remains the existing exception;
                # actual owner denials still apply before every component.
                if any(contains(root, prefix) for root in exclusions): fail()
                if prefix in known_parents and ident(os.fstat(directory)) != known_parents[prefix]: fail()
                next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = next_directory
                current = os.fstat(directory)
                if prefix in original and ident(current) != original[prefix]: fail()
                if prefix in known and not same(current, known[prefix]): fail()
            info = os.fstat(directory)
            if not stat.S_ISDIR(info.st_mode) or (expected is not None and not same(info, expected)): fail()
            check()
            return directory
        except:
            os.close(directory)
            raise
    # The witness is metadata-only, within the same already-owned sole scratch.
    # Negative alias comparison can refuse, never authorize another source path.
    import unicodedata
    def conservative(path):
        return unicodedata.normalize('NFD', path).casefold()
    scratch_path = scratch['rootAnchor']['rootPath']
    for path in [plan['sourceAnchor']['rootPath'], plan['gitDirectory'], plan['commonAnchor']['rootPath']]:
        if contains(conservative(path), conservative(scratch_path)) or contains(conservative(scratch_path), conservative(path)): fail()
    if os.path.dirname(scratch['file_path']) != scratch_path: fail()
    def open_scratch():
        directory = open_directory(scratch_path)
        if ident(os.fstat(directory)) != scratch['rootAnchor']['identity']:
            os.close(directory)
            fail()
        return directory
    expected = None
    if request['operation'] == 'VerifyPreparationObservation':
        receipt = request['observationWitness']
        if receipt['file_path'] != scratch['file_path']: fail()
        directory = open_scratch()
        file = None
        try:
            file = os.open(os.path.basename(receipt['file_path']), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            info = os.fstat(file)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or ident(info) != receipt['identity'] or info.st_size != receipt['byteLength'] or not 0 < info.st_size <= witness_limit: fail()
            encoded = bytearray()
            while len(encoded) < info.st_size:
                check()
                chunk = os.read(file, min(65536, info.st_size - len(encoded)))
                if not chunk: fail()
                encoded.extend(chunk)
            if not same(os.fstat(file), state(info)) or hashlib.sha256(encoded).hexdigest() != receipt['sha256']: fail()
            rebound = open_scratch()
            os.close(rebound)
            expected = json.loads(encoded)
            if expected['plan'] != plan: fail()
        finally:
            if file is not None: os.close(file)
            os.close(directory)
    anchors = []
    directories = []
    directory_paths = []
    listings = {}
    files = []
    absent = []
    total_entries = 0
    total_bytes = 0
    previous_dirs = {}
    previous_files = {}
    previous_absent = set()
    if expected is not None:
        expected_paths = []
        for item in expected['directories']:
            path = expected['anchors'][item['anchor']]['rootPath'] if item['parent'] == -1 else os.path.join(expected_paths[item['parent']], item['name'])
            expected_paths.append(path)
            previous_dirs[path] = {'path': path, 'entry': item['entry'], 'parentIdentity': item['parentIdentity'], 'listingSha256': item['listingSha256'], 'incomplete': item['incomplete']}
        for item in expected['files']:
            previous_files[os.path.join(expected_paths[item['directory']], item['name'])] = item
        previous_absent = {os.path.join(expected_paths[item['directory']], item['name']) for item in expected['absent']}
    # Source/common identities are original; the projected Git path is freshly
    # pinned each callback. A changed path projection is rejected by TS parsers.
    for path in dict.fromkeys([plan['sourceAnchor']['rootPath'], plan['gitDirectory'], plan['commonAnchor']['rootPath']]):
        directory = open_directory(path)
        parent = None
        try:
            info = os.fstat(directory)
            parent = open_directory(os.path.dirname(path))
            value = {'rootPath': path, 'entry': state(info), 'parentIdentity': ident(os.fstat(parent))}
            if expected is not None:
                previous = next((item for item in expected['anchors'] if item['rootPath'] == path), None)
                if previous != value: fail()
            anchors.append(value)
            known[path] = value['entry']
            known_parents[path] = value['parentIdentity']
        finally:
            if parent is not None: os.close(parent)
            os.close(directory)
    def anchor_for(path):
        candidates = [(index, item) for index, item in enumerate(anchors) if contains(item['rootPath'], path)]
        if not candidates: fail()
        return max(candidates, key=lambda pair: len(pair[1]['rootPath']))[0]
    def scan(path):
        nonlocal total_entries
        directory = open_directory(path)
        parent = None
        try:
            before = os.fstat(directory)
            parent = open_directory(os.path.dirname(path))
            parent_identity = ident(os.fstat(parent))
            values = []
            count = names = 0
            incomplete = False
            with os.scandir(directory) as iterator:
                for child in iterator:
                    check()
                    size = len(child.name.encode('utf-8', errors='strict'))
                    count += 1
                    names += size
                    if count > 10000 or names > 1024 * 1024 or (len(values) + 1) * 512 + names * 6 > 6 * 1024 * 1024: fail()
                    child_path = os.path.join(path, child.name)
                    if any(contains(root, child_path) for root in exclusions) or negative_name(child.name) in credential_names or negative_name(child.name) in agent_names:
                        incomplete = True
                        continue
                    values.append(state(child.stat(follow_symlinks=False), child.name))
            if not same(os.fstat(directory), state(before)): fail()
            # Stable, unambiguous full eligible state encoding, not just names.
            values.sort(key=lambda item: item['name'])
            listing_hash = digest({'entries': values, 'incomplete': incomplete})
            current = {'path': path, 'entry': state(before), 'parentIdentity': parent_identity, 'listingSha256': listing_hash, 'incomplete': incomplete}
            if expected is not None and previous_dirs.get(path) != current: fail()
            if path in listings:
                if listings[path][0] != current: fail()
            else:
                total_entries += len(values)
                if total_entries > 100000: fail()
                listings[path] = (current, {item['name']: item for item in values})
                known[path] = current['entry']
                known_parents[path] = current['parentIdentity']
            # Reopen through the same original roots/parents after listing.
            rebound = open_directory(path, current['entry'])
            os.close(rebound)
            return current, {item['name']: item for item in values}
        finally:
            if parent is not None: os.close(parent)
            os.close(directory)
    def directory(path):
        if path in directory_paths: return directory_paths.index(path)
        anchor_index = anchor_for(path)
        root = anchors[anchor_index]['rootPath']
        if path == root:
            parent_index, name = -1, ''
        else:
            parent_index = directory(os.path.dirname(path))
            name = os.path.basename(path)
            selected = listings[os.path.dirname(path)][1].get(name)
            if selected is None or selected['kind'] != 'directory': fail()
            select(parent_index, selected)
        physical, entries = scan(path)
        if len(directories) >= 2051: fail()
        value = {'anchor': anchor_index, 'parent': parent_index, 'name': name, 'entry': physical['entry'], 'parentIdentity': physical['parentIdentity'], 'entries': [], 'listingSha256': physical['listingSha256'], 'incomplete': physical['incomplete']}
        directories.append(value)
        directory_paths.append(path)
        return len(directories) - 1
    def select(index, value):
        selected = directories[index]['entries']
        if value not in selected: selected.append(value)
    def physical_absent(parent_path, name):
        path = os.path.join(parent_path, name)
        allowed(path)
        parent = open_directory(parent_path, listings[parent_path][0]['entry'])
        target = None
        try:
            try:
                target = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                pass
            else: fail()
            if not same(os.fstat(parent), listings[parent_path][0]['entry']): fail()
            rebound = open_directory(parent_path, listings[parent_path][0]['entry'])
            os.close(rebound)
        finally:
            if target is not None: os.close(target)
            os.close(parent)
        if len(absent) >= 24: fail()
        if expected is not None and path not in previous_absent: fail()
    def optional(path, limit, purpose='pointer'):
        nonlocal total_bytes
        allowed(path)
        # Resolve each actual parent from exact full names, physically qualifying
        # the first absent component. Never equate an OS alias to canonical name.
        anchor_path = anchors[anchor_for(path)]['rootPath']
        cursor = anchor_path
        parent_index = directory(cursor)
        relative_parts = os.path.relpath(path, anchor_path).split('/')
        for index, name in enumerate(relative_parts):
            if name in ('', '.', '..'): fail()
            values = listings[cursor][1]
            value = values.get(name)
            if value is None:
                physical_absent(cursor, name)
                missing = {'directory': parent_index, 'name': name}
                if missing not in absent: absent.append(missing)
                return None
            select(parent_index, value)
            if index < len(relative_parts) - 1:
                if value['kind'] != 'directory': fail()
                cursor = os.path.join(cursor, name)
                parent_index = directory(cursor)
                continue
            if value['kind'] != 'file' or value['nlink'] != 1 or value['size'] > limit: fail()
            file_path = os.path.join(cursor, name)
            previous = previous_files.get(file_path)
            if expected is not None and (previous is None or previous['entry'] != value): fail()
            read_request = {'operation': 'ReadBytes', 'file_path': file_path, 'rootAnchor': {'rootPath': anchors[anchor_for(file_path)]['rootPath'], 'identity': anchors[anchor_for(file_path)]['entry']['identity']}, 'parentIdentity': directories[parent_index]['entry']['identity'], 'identity': value['identity'], 'expectedState': {'size': value['size'], 'mtimeNs': value['mtimeNs'], 'ctimeNs': value['ctimeNs']}, 'deniedRoots': exclusions, 'limit': limit}
            content = anchored_read(read_request, deadline)
            decoded = base64.b64decode(content, validate=True)
            file_sha = hashlib.sha256(decoded).hexdigest()
            if expected is not None and previous['sha256'] != file_sha: fail()
            if not any(item['directory'] == parent_index and item['name'] == name for item in files):
                total_bytes += len(decoded)
                if len(files) >= 24 or total_bytes > 64 * 1024 * 1024: fail()
                files.append({'directory': parent_index, 'name': name, 'purpose': purpose, 'entry': value, 'bytes': content, 'sha256': file_sha})
            return decoded
    source_path = plan['sourceAnchor']['rootPath']
    source_index = directory(source_path)
    marker = listings[source_path][1].get('.git')
    if marker is None: fail()
    select(source_index, marker)
    if marker['kind'] == 'file': optional(os.path.join(source_path, '.git'), 4096, 'marker')
    elif marker['kind'] != 'directory': fail()
    # Keep every top-level entry the preparation inspector actually inspects.
    eligible = {'HEAD', 'refs', 'packed-refs', 'config', 'config.worktree', 'commondir'}
    for path in dict.fromkeys([plan['gitDirectory'], plan['commonAnchor']['rootPath']]):
        index = directory(path)
        for name, value in listings[path][1].items():
            if name in eligible:
                select(index, value)
                if name != 'refs' and value['kind'] == 'unsupported': fail()
        for name in ['config', 'config.worktree']:
            optional(os.path.join(path, name), 65536, 'config')
    optional(os.path.join(plan['gitDirectory'], 'commondir'), 4096)
    head = optional(os.path.join(plan['gitDirectory'], 'HEAD'), 4096)
    if head is None: fail()
    def next_reference(content):
        # EXACT ECMAScript WhiteSpace + LineTerminator set used by unchanged
        # headValue.trimEnd(). Python's default rstrip differs (NEL/controls/BOM).
        js_trim = ''.join(chr(value) for value in (0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, *range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff))
        text = content.decode('utf-8', errors='strict').rstrip(js_trim)
        if len(text) in (40, 64) and all(character in '0123456789abcdef' for character in text): return None
        if not text.startswith('ref: refs/'): fail()
        ref = text[5:]
        if len(ref.encode('utf-8')) > 4096 or any(ord(character) <= 32 or ord(character) == 127 or character in '~^:?*\\[' for character in ref) or '@{' in ref or ref.endswith('.') or '..' in ref or '//' in ref or ref.endswith('/') or any(part.startswith('.') or part.endswith('.lock') for part in ref.split('/')): fail()
        return ref
    reference = next_reference(head)
    seen = set()
    while reference is not None:
        if reference in seen or len(seen) >= 16: fail()
        seen.add(reference)
        value = optional(os.path.join(plan['commonAnchor']['rootPath'], reference), 4096)
        if value is None: break
        reference = next_reference(value)
    optional(os.path.join(plan['commonAnchor']['rootPath'], 'packed-refs'), 16 * 1024 * 1024, 'packed')
    # Fresh final listing comparisons close the capture itself; the later verify
    # is a distinct fresh physical pass after unchanged TS/private Git parsing.
    for path in list(directory_paths): scan(path)
    check()
    metadata = {'plan': plan, 'anchors': anchors, 'directories': directories, 'files': [{key: value for key, value in item.items() if key != 'bytes'} for item in files], 'absent': absent}
    if expected is not None:
        if metadata != expected: fail()
        return json.dumps({'verified': True})
    encoded = canonical(metadata).encode('ascii')
    if not 0 < len(encoded) <= witness_limit: fail()
    # Preflight complete response cap before witness publication or stdout.
    observation = {'version': version, 'anchors': anchors, 'directories': directories, 'files': files, 'absent': absent}
    if len(json.dumps({'content': json.dumps({'observation': observation, 'witness': {'file_path': scratch['file_path'], 'identity': {'dev': '9' * 32, 'ino': '9' * 32}, 'byteLength': len(encoded), 'sha256': 'f' * 64}})}).encode('utf-8')) + 1024 > response_limit: fail()
    directory = open_scratch()
    file = None
    try:
        file = os.open(os.path.basename(scratch['file_path']), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        offset = 0
        while offset < len(encoded):
            check()
            written = os.write(file, encoded[offset:offset + 65536])
            if written <= 0: fail()
            offset += written
        os.fsync(file)
        info = os.fstat(file)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != len(encoded): fail()
        rebound = open_scratch()
        os.close(rebound)
        check()
        return json.dumps({'observation': observation, 'witness': {'file_path': scratch['file_path'], 'identity': ident(info), 'byteLength': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()}})
    finally:
        if file is not None: os.close(file)
        os.close(directory)
`;

/** Exact private raw-dispatch schema. No unused nested caller data reaches IPC. */
export function projectNativePreparationObservationRequest(value: unknown) {
  const operation =
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'operation')
      : undefined;
  if (
    !operation ||
    !('value' in operation) ||
    !['CapturePreparationObservation', 'VerifyPreparationObservation'].includes(operation.value)
  )
    throw unavailable();
  const verify = operation.value === 'VerifyPreparationObservation';
  const item = record(value, [
    'operation',
    'observationPlan',
    'observationScratch',
    ...(verify ? ['observationWitness'] : []),
    'file_path',
    'identity',
    'parentIdentity',
    'limit',
    'timeoutMs',
  ]);
  const scratch = freezeNativePreparationObservationScratch(item.observationScratch);
  const target = identity(item.identity),
    parent = identity(item.parentIdentity);
  if (
    item.file_path !== scratch.file_path ||
    JSON.stringify(target) !== JSON.stringify(scratch.rootAnchor.identity) ||
    JSON.stringify(parent) !== JSON.stringify(target) ||
    item.limit !== 1 ||
    !Number.isSafeInteger(item.timeoutMs) ||
    item.timeoutMs < 1 ||
    item.timeoutMs > 30000
  )
    throw unavailable();
  const witness = verify
    ? freezeNativePreparationObservationWitness(item.observationWitness)
    : undefined;
  if (witness && witness.file_path !== scratch.file_path) throw unavailable();
  const projected = Object.freeze({
    operation: operation.value as 'CapturePreparationObservation' | 'VerifyPreparationObservation',
    observationPlan: freezeNativePreparationObservationPlan(item.observationPlan),
    observationScratch: scratch,
    ...(witness ? { observationWitness: witness } : {}),
    file_path: scratch.file_path,
    identity: target,
    parentIdentity: parent,
    limit: 1,
    timeoutMs: item.timeoutMs as number,
  });
  if (
    Buffer.byteLength(JSON.stringify(projected)) > nativePreparationObservationLimits.requestBytes
  )
    throw unavailable();
  return projected;
}
/** Same private helper, original current owner supplies the enforced transport.
 * Data projection is not permission or an optional host-execution fallback. */
async function observationOperation(
  operation: 'CapturePreparationObservation' | 'VerifyPreparationObservation',
  originalPlan: NativePreparationObservationPlan,
  originalScratch: NativePreparationObservationScratch,
  originalWitness: NativePreparationObservationWitness | undefined,
  signal: AbortSignal,
  timeoutMs: number,
  transport: NativeFileHelperTransport,
) {
  if (typeof transport !== 'function') throw unavailable();
  signal.throwIfAborted();
  const plan = freezeNativePreparationObservationPlan(originalPlan);
  const scratch = freezeNativePreparationObservationScratch(originalScratch);
  const witness =
    originalWitness === undefined
      ? undefined
      : freezeNativePreparationObservationWitness(originalWitness);
  if (
    (operation === 'VerifyPreparationObservation') !== !!witness ||
    (witness && witness.file_path !== scratch.file_path) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw unavailable();
  const request = projectNativePreparationObservationRequest({
    operation,
    observationPlan: plan,
    observationScratch: scratch,
    ...(witness ? { observationWitness: witness } : {}),
    file_path: scratch.file_path,
    identity: scratch.rootAnchor.identity,
    parentIdentity: scratch.rootAnchor.identity,
    limit: 1,
    timeoutMs,
  });
  if (Buffer.byteLength(JSON.stringify(request)) > nativePreparationObservationLimits.requestBytes)
    throw unavailable();
  const { executeNativeFileOperation } = await import('./native-file-operation.js');
  const result = await executeNativeFileOperation(request, signal, timeoutMs, transport);
  signal.throwIfAborted();
  if (
    result.is_error ||
    Buffer.byteLength(result.content) > nativePreparationObservationLimits.responseBytes
  )
    throw unavailable();
  try {
    return JSON.parse(result.content) as unknown;
  } catch {
    throw unavailable();
  }
}
export async function captureNativePreparationObservation(
  plan: NativePreparationObservationPlan,
  scratch: NativePreparationObservationScratch,
  signal: AbortSignal,
  timeoutMs: number,
  transport: NativeFileHelperTransport,
): Promise<Readonly<NativePreparationObservationCapture>> {
  const value = record(
    await observationOperation(
      'CapturePreparationObservation',
      plan,
      scratch,
      undefined,
      signal,
      timeoutMs,
      transport,
    ),
    ['observation', 'witness'],
  );
  const result = Object.freeze({
    observation: freezeNativePreparationObservationData(value.observation),
    witness: freezeNativePreparationObservationWitness(value.witness),
  });
  if (result.witness.file_path !== scratch.file_path) throw unavailable();
  return result;
}
export async function verifyNativePreparationObservation(
  plan: NativePreparationObservationPlan,
  scratch: NativePreparationObservationScratch,
  witness: NativePreparationObservationWitness,
  signal: AbortSignal,
  timeoutMs: number,
  transport: NativeFileHelperTransport,
): Promise<void> {
  const value = record(
    await observationOperation(
      'VerifyPreparationObservation',
      plan,
      scratch,
      witness,
      signal,
      timeoutMs,
      transport,
    ),
    ['verified'],
  );
  if (value.verified !== true) throw unavailable();
}
