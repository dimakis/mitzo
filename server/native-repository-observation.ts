import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { NativeFileHelperTransport } from './native-file-operation.js';
import { PreparedTopologySchema, preparedTopologyPython } from './native-repository-topology.js';
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes('\0'));
const Plan = z
  .strictObject({
    version: z.literal('repository-read-v1'),
    mode: z.enum([
      'discovery',
      'orientation',
      'allocation',
      'adoption',
      'topology',
      'base',
      'task-topology',
    ]),
    sourcePath: path,
    taskRoot: path.optional(),
    workspaceId: z.uuid().optional(),
    expectedTopology: PreparedTopologySchema.optional(),
    readableRoots: z.array(path).min(1).max(256),
    deniedRoots: z.array(path).max(256),
    excludedNames: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine((name) => !name.includes('/') && name !== '.' && name !== '..'),
      )
      .max(32),
  })
  .superRefine((value, ctx) => {
    if (
      ['allocation', 'adoption', 'topology'].includes(value.mode) &&
      (!value.taskRoot || !value.workspaceId)
    )
      ctx.addIssue({ code: 'custom', message: 'Allocation identity required' });
    const expected = value.expectedTopology;
    if (
      expected &&
      (value.mode !== (expected.linked ? 'topology' : 'task-topology') ||
        value.sourcePath !== (expected.source?.root.path ?? expected.directory) ||
        (expected.linked && expected.directory !== value.taskRoot + '/repo-' + value.workspaceId))
    )
      ctx.addIssue({ code: 'custom', message: 'Exact topology phase required' });
  });
export type RepositoryObservationPlan = z.infer<typeof Plan>;
export type RepositoryObservationInput = Pick<
  RepositoryObservationPlan,
  'mode' | 'sourcePath' | 'taskRoot' | 'workspaceId'
> & {
  readableRoots?: readonly string[];
  additionalDeniedRoots?: readonly string[];
};
const Identity = z.strictObject({
  dev: z.string().regex(/^\d{1,32}$/),
  ino: z.string().regex(/^\d{1,32}$/),
});
const Entry = z.strictObject({
  name: z.string().max(4096),
  identity: Identity,
  kind: z.enum(['file', 'directory', 'unsupported']),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 40),
  mode: z.number().int().nonnegative(),
  nlink: z.number().int().nonnegative(),
  mtimeNs: z.string().regex(/^\d{1,32}$/),
  ctimeNs: z.string().regex(/^\d{1,32}$/),
});
const Data = z.strictObject({
  version: z.literal('repository-read-v1'),
  mode: z.enum([
    'discovery',
    'orientation',
    'allocation',
    'adoption',
    'topology',
    'base',
    'task-topology',
  ]),
  entries: z.array(z.strictObject({ path, entry: Entry })).max(100000),
  directories: z
    .array(
      z.strictObject({
        path,
        complete: z.boolean(),
        incomplete: z.boolean(),
        names: z.array(z.string().min(1).max(1024)).max(10000),
      }),
    )
    .max(4096),
  files: z
    .array(z.strictObject({ path, bytes: z.string().max(24 * 1024 * 1024), link: z.boolean() }))
    .max(512),
  absent: z.array(path).max(1024),
});
export type RepositoryObservationData = z.infer<typeof Data>;
export interface RepositoryObservationCapture {
  readonly plan: Readonly<RepositoryObservationPlan>;
  readonly data: Readonly<RepositoryObservationData>;
  readonly digest: string;
}
export class RepositoryObservationReadAccessError extends Error {}
export class RepositoryObservationMissingError extends Error {
  readonly code = 'ENOENT';
}
const fail = () => Error('Repository observation unavailable');
export function freezeRepositoryObservationPlan(
  input: unknown,
): Readonly<RepositoryObservationPlan> {
  const parsed = Plan.parse(input);
  Object.freeze(parsed.readableRoots);
  Object.freeze(parsed.deniedRoots);
  Object.freeze(parsed.excludedNames);
  const freeze = (value: object) => {
    for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
    Object.freeze(value);
  };
  if (parsed.expectedTopology) freeze(parsed.expectedTopology);
  return Object.freeze(parsed);
}
export function projectRepositoryObservationRequest(input: unknown) {
  const request = z
    .strictObject({
      operation: z.enum(['CaptureRepositoryObservation', 'VerifyRepositoryObservation']),
      repositoryPlan: Plan,
      repositoryDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      identity: z.null(),
      file_path: path,
      limit: z.literal(1),
      timeoutMs: z.number().int().min(1).max(30000),
    })
    .parse(input);
  if (
    request.file_path !== request.repositoryPlan.sourcePath ||
    (request.operation === 'VerifyRepositoryObservation') !== !!request.repositoryDigest
  )
    throw fail();
  return request;
}
async function run(
  plan: Readonly<RepositoryObservationPlan>,
  digest: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
  transport: NativeFileHelperTransport,
) {
  const request = projectRepositoryObservationRequest({
    operation: digest ? 'VerifyRepositoryObservation' : 'CaptureRepositoryObservation',
    repositoryPlan: plan,
    ...(digest ? { repositoryDigest: digest } : {}),
    identity: null,
    file_path: plan.sourcePath,
    limit: 1,
    timeoutMs,
  });
  const { executeNativeFileOperation } = await import('./native-file-operation.js');
  const result = await executeNativeFileOperation(request, signal, timeoutMs, transport);
  signal.throwIfAborted();
  if (result.is_error) {
    if (result.content === 'Repository read access required')
      throw new RepositoryObservationReadAccessError('Repository read access required');
    if (result.content === 'Repository source missing')
      throw new RepositoryObservationMissingError('Repository source missing');
    throw fail();
  }
  return JSON.parse(result.content);
}
export async function captureRepositoryObservation(
  input: unknown,
  signal: AbortSignal,
  timeoutMs: number,
  transport: NativeFileHelperTransport,
): Promise<Readonly<RepositoryObservationCapture>> {
  const plan = freezeRepositoryObservationPlan(input),
    value = await run(plan, undefined, signal, timeoutMs, transport),
    data = Data.parse(value.data);
  if (
    data.mode !== plan.mode ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    (plan.expectedTopology && value.topologyVerified !== true)
  )
    throw fail();
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  if (
    createHash('sha256')
      .update(JSON.stringify(canonical(data)))
      .digest('hex') !== value.digest
  )
    throw fail();
  const entries = new Map(data.entries.map((item) => [item.path, item.entry]));
  if (entries.size !== data.entries.length) throw fail();
  let total = 0;
  const seen = new Set<string>();
  for (const file of data.files) {
    const entry = entries.get(file.path);
    if (
      !entry ||
      seen.has(file.path) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.bytes) ||
      file.bytes.length % 4
    )
      throw fail();
    seen.add(file.path);
    const bytes = Buffer.from(file.bytes, 'base64');
    total += bytes.length;
    if (
      bytes.toString('base64') !== file.bytes ||
      bytes.length > entry.size ||
      total > 32 * 1024 * 1024 ||
      (file.link ? entry.kind !== 'unsupported' : entry.kind !== 'file' || entry.nlink !== 1)
    )
      throw fail();
  }
  for (const directory of data.directories)
    if (
      entries.get(directory.path)?.kind !== 'directory' ||
      new Set(directory.names).size !== directory.names.length ||
      directory.names.some(
        (name) =>
          name.includes('/') ||
          name === '.' ||
          name === '..' ||
          !entries.has(directory.path + (directory.path === '/' ? '' : '/') + name),
      )
    )
      throw fail();
  for (const absent of data.absent) if (entries.has(absent)) throw fail();
  const freeze = (value: object) => {
    Object.values(value).forEach((item) => {
      if (item && typeof item === 'object') freeze(item);
    });
    Object.freeze(value);
  };
  freeze(data);
  return Object.freeze({ plan, data, digest: value.digest });
}
export async function verifyRepositoryObservation(
  plan: Readonly<RepositoryObservationPlan>,
  digest: string,
  signal: AbortSignal,
  timeoutMs: number,
  transport: NativeFileHelperTransport,
) {
  const value = await run(plan, digest, signal, timeoutMs, transport);
  if (value.verified !== true || Object.keys(value).length !== 1) throw fail();
}
/** Fixed read-only operation inside the existing descriptor helper and SRT boundary. */
export const repositoryObservationPython = String.raw`
${preparedTopologyPython}
class RepositorySourceMissingError(Exception): pass
def repository_observation(request):
    import re
    plan = request['repositoryPlan']
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    exclusions, excluded_names, readable = plan['deniedRoots'], set(plan['excludedNames']), plan['readableRoots']
    entries, directories, files, absent = {}, {}, {}, set()
    total_bytes = 0
    def fail(): raise RuntimeError('Repository observation unavailable')
    def check():
        if time.monotonic() >= deadline: fail()
    def contains(root, path): return path == root or path.startswith(root.rstrip('/') + '/')
    def allowed(path, walk=False):
        check()
        if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or '\x00' in path or len(path.encode()) > 4096: fail()
        if any(contains(root, path) for root in exclusions): raise PermissionError('Repository read access required')
        if not any(contains(root, path) or (walk and contains(path, root)) for root in readable): raise PermissionError('Repository read access required')
        parts = path.split('/')
        for index, part in enumerate(parts):
            if part in excluded_names and not (part in ('.claude', '.cursor', '.codex') and ((index + 1 < len(parts) and parts[index + 1] == 'worktrees') or (walk and index + 1 == len(parts)))): fail()
    def ident(info): return {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
    def state(path, info):
        directory = stat.S_ISDIR(info.st_mode)
        return {'name': os.path.basename(path), 'identity': ident(info), 'kind': 'directory' if directory else ('file' if stat.S_ISREG(info.st_mode) else 'unsupported'), 'size': 0 if directory else info.st_size, 'mode': info.st_mode, 'nlink': 0 if directory else info.st_nlink, 'mtimeNs': '0' if directory else str(info.st_mtime_ns), 'ctimeNs': '0' if directory else str(info.st_ctime_ns)}
    directory_fds = {}
    def open_directory(path):
        allowed(path, True)
        if path in directory_fds: return os.dup(directory_fds[path])
        fd, prefix = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), ''
        try:
            for part in [part for part in path.split('/') if part]:
                prefix += '/' + part; allowed(prefix, True)
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = next_fd
            if len(directory_fds) >= 128:
                oldest = next(iter(directory_fds)); os.close(directory_fds.pop(oldest))
            directory_fds[path] = os.dup(fd)
            return fd
        except:
            os.close(fd); raise
    def entry(path):
        allowed(path)
        if any(contains(missing,path) for missing in absent): return None
        fd = open_directory(os.path.dirname(path))
        try:
            try: info = os.stat(os.path.basename(path), dir_fd=fd, follow_symlinks=False) if path != '/' else os.fstat(fd)
            except FileNotFoundError:
                absent.add(path); return None
            value = state(path, info)
            if path in entries and entries[path] != value: fail()
            entries[path] = value
            if len(entries) > 100000: fail()
            return value
        finally: os.close(fd)
    def bounded_names(fd, maximum=10000):
        names, name_bytes = [], 0
        with os.scandir(fd) as children:
            for child in children:
                check(); name_bytes += len(os.fsencode(child.name))
                if len(names) >= maximum or name_bytes > 1024 * 1024: fail()
                names.append(child.name)
        return sorted(names)
    def scan(path, names=None, maximum=10000):
        allowed(path)
        root = entry(path)
        if root is None: return None
        if root['kind'] != 'directory': fail()
        fd = open_directory(path)
        try:
            if ident(os.fstat(fd)) != root['identity']: fail()
            selected = bounded_names(fd, maximum) if names is None else list(names)
            if len(selected) > 10000: fail()
            kept, incomplete = [], False
            for name in selected:
                check(); child = os.path.join(path, name)
                if name in excluded_names or any(contains(denied, child) for denied in exclusions):
                    incomplete = True; continue
                if entry(child) is not None: kept.append(name)
            observed = {'path': path, 'complete': names is None, 'incomplete': incomplete, 'names': sorted(kept)}
            if path not in directories or observed['complete']: directories[path] = observed
            elif not directories[path]['complete']: directories[path]['names'] = sorted(set(directories[path]['names'] + observed['names']))
            if len(directories) > 4096: fail()
            return kept
        finally: os.close(fd)
    def read(path, limit=4096, instruction=False):
        nonlocal total_bytes
        allowed(path); parent = os.path.dirname(path)
        if scan(parent, [os.path.basename(path)]) is None: return None
        value = entry(path)
        if value is None: return None
        link = stat.S_ISLNK(value['mode'])
        if value['nlink'] != 1 or (value['kind'] != 'file' and not (instruction and link)): fail()
        if value['size'] > limit and not instruction: fail()
        parent_entry = entry(parent)
        # Hold one no-follow parent descriptor for this observation. Verification
        # opens the absolute chain afresh; no descriptor survives this process.
        fd = open_directory(parent)
        try:
            if ident(os.fstat(fd)) != parent_entry['identity']: fail()
            name = os.path.basename(path)
            if state(path, os.stat(name, dir_fd=fd, follow_symlinks=False)) != value: fail()
            if link:
                data = os.readlink(name, dir_fd=fd).encode('utf-8')
                if len(data) > limit: fail()
            else:
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    if state(path, os.fstat(child)) != value: fail()
                    data = bytearray()
                    remaining = min(value['size'], limit)
                    while remaining:
                        check(); chunk = os.read(child, min(65536, remaining))
                        if not chunk: fail()
                        data.extend(chunk); remaining -= len(chunk)
                    if state(path, os.fstat(child)) != value: fail()
                    data = bytes(data)
                finally: os.close(child)
            if state(path, os.stat(name, dir_fd=fd, follow_symlinks=False)) != value: fail()
        finally: os.close(fd)
        encoded = base64.b64encode(data).decode('ascii')
        total_bytes += len(data)
        if total_bytes > 32 * 1024 * 1024: fail()
        files[path] = {'path': path, 'bytes': encoded, 'link': link}
        if len(files) > 512: fail()
        return data
    requested = plan['sourcePath']; source = requested
    try: initial = entry(requested)
    except FileNotFoundError: raise RepositorySourceMissingError('Repository source missing')
    if initial is None: raise RepositorySourceMissingError('Repository source missing')
    for root in readable: entry(root)
    for _ in range(128):
        if entry(source) is None or entries[source]['kind'] != 'directory': fail()
        scan(source, None if plan['mode'] in ('allocation','adoption') else ['.git', 'HEAD', 'config', 'objects'])
        marker = os.path.join(source, '.git'); value = entry(marker)
        if value is not None: break
        if plan['mode'] == 'task-topology': fail()
        parent = os.path.dirname(source)
        if parent == source: fail()
        source = parent
    else: fail()
    git = marker
    if plan['mode'] == 'task-topology' and value['kind'] != 'directory': fail()
    if value['kind'] == 'file':
        text = read(marker).decode('utf-8')
        if plan.get('expectedTopology') is not None and re.fullmatch(r'gitdir: ([^\r\n\x00]+)\r?\n?', text) is None: fail()
        if not text.startswith('gitdir: ') or '\x00' in text: fail()
        pointer = text[8:].rstrip('\r\n')
        if not pointer or '\n' in pointer or '\r' in pointer: fail()
        git = os.path.normpath(os.path.join(source, pointer))
    elif value['kind'] != 'directory': fail()
    if entry(git) is None or entries[git]['kind'] != 'directory': fail()
    common = git; pointer = read(os.path.join(git, 'commondir'))
    if pointer is not None:
        if plan['mode'] == 'task-topology': fail()
        pointer = pointer.decode('utf-8')
        if plan.get('expectedTopology') is not None and re.fullmatch(r'[^\r\n\x00]+\r?\n?', pointer) is None: fail()
        pointer = pointer.rstrip('\r\n')
        if not pointer or '\x00' in pointer or '\n' in pointer or '\r' in pointer: fail()
        common = os.path.normpath(os.path.join(git, pointer))
    for root in sorted(set([git, common])):
        scan(root, (['HEAD','config','config.worktree','commondir','packed-refs'] + (['index','shallow'] if plan['mode']=='task-topology' else [])) if plan['mode'] in ('base','task-topology') else None)
        for name in ['config', 'config.worktree']: read(os.path.join(root, name), 65536)
    if plan['mode'] in ('allocation','task-topology'): read(os.path.join(common, 'shallow'), 65536)
    for name in ['alternates', 'http-alternates']:
        pointer = read(os.path.join(common, 'objects', 'info', name), 65536)
        if pointer is not None and (plan['mode'] == 'task-topology' or pointer.strip()): fail()
    def chain(head):
        value = read(head); seen = set()
        while value is not None and value.startswith(b'ref: '):
            ref = value[5:].decode('utf-8').rstrip('\r\n')
            if ref in seen or len(seen) >= 16 or not ref.startswith('refs/') or any(part in ('', '.', '..') for part in ref.split('/')) or '\x00' in ref: fail()
            seen.add(ref); path = os.path.join(common, ref)
            try: value = read(path)
            except FileNotFoundError: absent.add(path); return
    chain(os.path.join(git, 'HEAD')); read(os.path.join(common, 'packed-refs'), 16 * 1024 * 1024)
    if plan['mode'] == 'orientation':
        # Worktree orientation is advisory. An unavailable registry must not
        # prevent safe HEAD inspection or claim a complete/empty registry.
        saved = (entries.copy(), {path: dict(record, names=list(record['names'])) for path, record in directories.items()}, files.copy(), absent.copy(), total_bytes)
        try:
            read(os.path.join(common, 'locked'), 65536)
            chain(os.path.join(common, 'HEAD')); registry = os.path.join(common, 'worktrees'); names = scan(registry, maximum=256)
            if names is not None:
                if len(names) > 256: fail()
                for name in names:
                    path = os.path.join(registry, name); scan(path, ['HEAD', 'gitdir', 'locked'])
                    chain(os.path.join(path, 'HEAD')); read(os.path.join(path, 'gitdir')); read(os.path.join(path, 'locked'), 65536)
        except Exception:
            entries, directories, files, absent, total_bytes = saved
        cursor, count = requested, 0
        while True:
            if count >= 32: break
            count += 1
            for name in ['AGENTS.md', 'CLAUDE.md']:
                path, seen = os.path.join(cursor, name), set()
                for _ in range(16):
                    try:
                        value = read(path, 65536, True)
                        if value is None or not files[path]['link']: break
                        if path in seen: fail()
                        seen.add(path); path = os.path.normpath(os.path.join(os.path.dirname(path), value.decode('utf-8')))
                    except Exception: break
            parent = os.path.dirname(cursor)
            if parent == cursor: break
            cursor = parent
    elif plan['mode'] in ('allocation','adoption','topology'):
        task, workspace = plan['taskRoot'], plan['workspaceId']; scan(task)
        suffixes = ['worktrees', 'refs', 'refs/heads', 'refs/heads/mitzo']
        if plan['mode'] != 'topology': suffixes += ['logs', 'logs/refs', 'logs/refs/heads', 'logs/refs/heads/mitzo']
        for suffix in suffixes:
            path = os.path.join(common, suffix)
            try: scan(path)
            except FileNotFoundError: absent.add(path)
        ref = 'refs/heads/mitzo/repo-' + workspace
        targets = [os.path.join(task, 'repo-' + workspace), os.path.join(common, 'worktrees', 'repo-' + workspace), os.path.join(common, ref), os.path.join(common, ref + '.lock'), os.path.join(common, 'logs', ref), os.path.join(common, 'logs', ref + '.lock')]
        for path in targets[:3] if plan['mode'] == 'topology' else targets:
            try: entry(path)
            except FileNotFoundError: absent.add(path)
        if plan['mode'] in ('adoption','topology'):
            task_path, admin = targets[0], targets[1]
            scan(task_path, ['.git']); read(os.path.join(task_path,'.git'))
            scan(admin)
            names = ['HEAD','commondir','gitdir'] if plan['mode'] == 'topology' else ['HEAD','commondir','gitdir','index','locked']
            for name in names:
                read(os.path.join(admin,name),16*1024*1024 if name=='index' else 65536)
            read(targets[2],128 if plan['mode']=='topology' else 4096)
            if plan['mode'] == 'adoption': read(targets[4],65536)
    if plan.get('expectedTopology') is not None:
        assert_prepared_topology(plan['expectedTopology'], source, git, common, entries, files, absent, lambda: deadline - time.monotonic(), check, fail)
        # The same physical phase owns the parser wait and postconditions. Keep
        # original descriptors alive, then re-open absolute chains so a retained
        # descriptor cannot conceal root/gitfile substitution during that wait.
        fresh = {}
        def current_directory(path):
            allowed(path, True)
            if path in fresh: return fresh[path]
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            prefix = ''
            try:
                for part in [part for part in path.split('/') if part]:
                    prefix += '/' + part; allowed(prefix, True)
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd); fd = child
                if len(fresh) >= 128:
                    oldest = next(iter(fresh)); os.close(fresh.pop(oldest))
                fresh[path] = fd
                return fd
            except:
                os.close(fd); raise
        try:
            for path, before in list(entries.items()):
                check()
                parent = current_directory(os.path.dirname(path))
                info = os.fstat(parent) if path == '/' else os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
                if state(path, info) != before: fail()
            for path, before in list(directories.items()):
                if not before['complete']: continue
                names = bounded_names(current_directory(path)); kept = []; incomplete = False
                for name in names:
                    child = os.path.join(path, name)
                    if name in excluded_names or any(contains(root, child) for root in exclusions): incomplete = True
                    else: kept.append(name)
                if sorted(kept) != before['names'] or incomplete != before['incomplete']: fail()
            for path, captured in list(files.items()):
                check()
                if captured['link']: fail()
                expected = base64.b64decode(captured['bytes'], validate=True)
                parent = current_directory(os.path.dirname(path)); name = os.path.basename(path)
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if state(path, os.fstat(child)) != entries[path]: fail()
                    data = bytearray()
                    while len(data) < len(expected):
                        check(); chunk = os.read(child, min(65536, len(expected) - len(data)))
                        if not chunk: fail()
                        data.extend(chunk)
                    if bytes(data) != expected or state(path, os.fstat(child)) != entries[path] or state(path, os.stat(name, dir_fd=parent, follow_symlinks=False)) != entries[path]: fail()
                finally: os.close(child)
            for path in absent:
                check()
                try:
                    parent = current_directory(os.path.dirname(path))
                    os.stat(os.path.basename(path), dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: continue
                fail()
        finally:
            for fd in fresh.values(): os.close(fd)
        # Refuse a moved/replaced parent even when every byte above was read
        # from a still-live original descriptor.
        for path, original in directory_fds.items():
            check(); fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            prefix = ''
            try:
                for part in [part for part in path.split('/') if part]:
                    prefix += '/' + part; allowed(prefix, True)
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd); fd = child
                if ident(os.fstat(fd)) != ident(os.fstat(original)): fail()
            finally: os.close(fd)
    data = {'version': plan['version'], 'mode': plan['mode'], 'entries': [{'path': path, 'entry': entries[path]} for path in sorted(entries)], 'directories': [directories[path] for path in sorted(directories)], 'files': [files[path] for path in sorted(files)], 'absent': sorted(absent)}
    for fd in directory_fds.values(): os.close(fd)
    directory_fds.clear()
    encoded = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if len(encoded) > 48 * 1024 * 1024: fail()
    digest = hashlib.sha256(encoded).hexdigest()
    if request['operation'] == 'VerifyRepositoryObservation':
        if digest != request['repositoryDigest']: fail()
        return json.dumps({'verified': True})
    return json.dumps({'data': data, 'digest': digest, **({'topologyVerified': True} if plan.get('expectedTopology') is not None else {})})
`;

/** Standalone fixed reader: pass only JSON over stdin, never through shell source. */
export const repositoryObservationProgram = String.raw`
import base64, hashlib, json, os, stat, sys, time
${repositoryObservationPython}
try:
    request = json.load(sys.stdin)
    content = repository_observation(request)
    envelope = json.dumps({'content': content, 'is_error': False})
    if len((envelope + '\n').encode('utf-8')) > 64 * 1024 * 1024:
        raise RuntimeError('Repository observation unavailable')
    print(envelope)
except RepositorySourceMissingError:
    print(json.dumps({'content': 'Repository source missing', 'is_error': True}))
except PermissionError:
    print(json.dumps({'content': 'Repository read access required', 'is_error': True}))
except Exception:
    print(json.dumps({'content': 'Repository observation unavailable', 'is_error': True}))
`;
