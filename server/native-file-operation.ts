import { execFile } from 'node:child_process';

// Python exposes openat via dir_fd on macOS/Linux. Node has no equivalent API.
// Keep the helper embedded so tsc/deploy cannot omit a required runtime asset.
// No user text is interpolated into source or argv: the request travels over stdin.
const helper = String.raw`
import base64, json, os, stat, sys, time

def anchored_read(request):
    deadline = time.monotonic() + request['timeoutMs'] / 1000
    def check():
        if time.monotonic() >= deadline:
            raise RuntimeError('Anchored read deadline exceeded')
    def parts(path):
        if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or len(path.encode('utf-8')) > 4096:
            raise RuntimeError('Invalid anchored read path')
        result = [part for part in path.split('/') if part]
        if len(result) > 128 or any(part in ('.', '..') for part in result):
            raise RuntimeError('Anchored read path depth exceeded')
        return result
    def matches(target_stat, expected):
        return str(target_stat.st_dev) == expected['dev'] and str(target_stat.st_ino) == expected['ino']
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW') or os.scandir not in os.supports_fd:
        raise RuntimeError('Anchored native reads unavailable')
    path_parts = parts(request['file_path'])
    anchor = request['rootAnchor']
    root_parts = parts(anchor['rootPath'])
    if path_parts[:len(root_parts)] != root_parts or (not path_parts and request['operation'] != 'ListDirectory'):
        raise RuntimeError('Anchored read outside captured root')
    operation = request['operation']
    exclusions = request['deniedRoots']
    def excluded(path):
        return any(path == root or path.startswith(root.rstrip('/') + '/') for root in exclusions)
    if excluded(request['file_path']):
        raise RuntimeError('Anchored read unavailable')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    file = None
    try:
        if not root_parts and not matches(os.fstat(directory), anchor['identity']):
            raise RuntimeError('Captured read root changed')
        for index, part in enumerate(path_parts[:-1]):
            check()
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
            # Do not stat/list/open any descendant until the immutable authorized
            # root has been recognized through its pinned descriptor.
            if index + 1 == len(root_parts) and not matches(os.fstat(directory), anchor['identity']):
                raise RuntimeError('Captured read root changed')
        if len(path_parts) > len(root_parts) and not matches(os.fstat(directory), request['parentIdentity']):
            raise RuntimeError('Captured read parent changed')
        if operation == 'ReadLink':
            if os.stat not in os.supports_dir_fd or os.readlink not in os.supports_dir_fd:
                raise RuntimeError('Anchored native reads unavailable')
            before = os.stat(path_parts[-1], dir_fd=directory, follow_symlinks=False)
            if len(path_parts) == len(root_parts) or not matches(before, request['identity']) or not stat.S_ISLNK(before.st_mode) or before.st_nlink != 1:
                raise RuntimeError('Captured link changed')
            expected = request.get('expectedState')
            if expected is not None and (before.st_size != expected['size'] or str(before.st_mtime_ns) != expected['mtimeNs'] or str(before.st_ctime_ns) != expected['ctimeNs']):
                raise RuntimeError('Captured link state changed')
            if before.st_size > request['limit']:
                raise RuntimeError('Anchored byte limit exceeded')
            check()
            # Python os.readlink has no buffer bound. Use the same platform's
            # readlinkat with a fixed 4097-byte buffer before any target decoding.
            import ctypes
            readlinkat = ctypes.CDLL(None, use_errno=True).readlinkat
            readlinkat.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t]
            readlinkat.restype = ctypes.c_ssize_t
            buffer = ctypes.create_string_buffer(request['limit'] + 1)
            length = readlinkat(directory, os.fsencode(path_parts[-1]), buffer, request['limit'] + 1)
            if length < 0 or length > request['limit']:
                raise RuntimeError('Anchored link unavailable')
            text = buffer.raw[:length]
            after = os.stat(path_parts[-1], dir_fd=directory, follow_symlinks=False)
            if len(text) > request['limit'] or not matches(after, request['identity']) or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns or after.st_nlink != 1:
                raise RuntimeError('Captured link changed')
            check()
            return base64.b64encode(text).decode('ascii')
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if operation == 'ListDirectory':
            flags |= os.O_DIRECTORY
        file = os.dup(directory) if not path_parts else os.open(path_parts[-1], flags, dir_fd=directory)
        target_stat = os.fstat(file)
        if len(path_parts) == len(root_parts) and not matches(target_stat, anchor['identity']):
            raise RuntimeError('Captured read root changed')
        if not matches(target_stat, request['identity']):
            raise RuntimeError('Captured read target changed')
        if operation == 'ListDirectory':
            if not stat.S_ISDIR(target_stat.st_mode):
                raise RuntimeError('Anchored directory required')
            entries = []
            name_bytes = 0
            scanned = 0
            incomplete = False
            with os.scandir(file) as iterator:
                for entry in iterator:
                    check()
                    name_bytes += len(entry.name.encode('utf-8', errors='strict'))
                    scanned += 1
                    if scanned > request['maxEntries'] or name_bytes > request['maxNameBytes'] or (len(entries) + 1) * 512 + name_bytes * 6 > 6 * 1024 * 1024:
                        raise RuntimeError('Anchored directory limit exceeded')
                    if excluded(os.path.join(request['file_path'], entry.name)):
                        incomplete = True
                        continue
                    child = entry.stat(follow_symlinks=False)
                    kind = 'file' if stat.S_ISREG(child.st_mode) else 'directory' if stat.S_ISDIR(child.st_mode) else 'unsupported'
                    entries.append({'name': entry.name, 'identity': {'dev': str(child.st_dev), 'ino': str(child.st_ino)}, 'kind': kind, 'size': child.st_size, 'mode': child.st_mode, 'nlink': child.st_nlink, 'mtimeNs': str(child.st_mtime_ns), 'ctimeNs': str(child.st_ctime_ns)})
            after = os.fstat(file)
            if target_stat.st_mtime_ns != after.st_mtime_ns or target_stat.st_ctime_ns != after.st_ctime_ns:
                raise RuntimeError('Anchored directory changed')
            content = json.dumps({'identity': request['identity'], 'entries': entries, 'truncated': False, 'incomplete': incomplete}, ensure_ascii=True)
            if len(content.encode('utf-8')) > 6 * 1024 * 1024:
                raise RuntimeError('Anchored directory output limit exceeded')
            return content
        if not stat.S_ISREG(target_stat.st_mode) or target_stat.st_nlink != 1:
            raise RuntimeError('Anchored read requires an unaliased regular file')
        expected_state = request.get('expectedState')
        if expected_state is not None and (target_stat.st_size != expected_state['size'] or str(target_stat.st_mtime_ns) != expected_state['mtimeNs'] or str(target_stat.st_ctime_ns) != expected_state['ctimeNs']):
            raise RuntimeError('Captured read state changed')
        prefix = request.get('prefix', False)
        if target_stat.st_size > request['limit'] and not prefix:
            raise RuntimeError('Anchored byte limit exceeded')
        read_size = min(target_stat.st_size, request['limit'])
        data = bytearray()
        while len(data) < read_size:
            check()
            chunk = os.read(file, min(65536, read_size - len(data)))
            if not chunk:
                raise RuntimeError('Anchored file changed')
            data.extend(chunk)
        after = os.fstat(file)
        if target_stat.st_size != after.st_size or target_stat.st_mtime_ns != after.st_mtime_ns or target_stat.st_ctime_ns != after.st_ctime_ns or after.st_nlink != 1:
            raise RuntimeError('Anchored file changed')
        encoded = base64.b64encode(data).decode('ascii')
        return json.dumps({'bytes': encoded, 'truncated': len(data) < target_stat.st_size}) if prefix else encoded
    finally:
        if file is not None:
            os.close(file)
        os.close(directory)

def execute(request):
    if request['operation'] in ('ReadBytes', 'ListDirectory', 'ReadLink'):
        return anchored_read(request)
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise RuntimeError('Descriptor-relative native file operations are unavailable')
    path = request['file_path']
    parts = path.split('/')
    if not path.startswith('/') or any(p in ('.', '..') for p in parts):
        raise RuntimeError('Invalid canonical native file path')
    parts = [p for p in parts if p]
    if not parts:
        raise RuntimeError('Native tools require a regular file')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    file = None
    try:
        # Each lookup is relative to the pinned parent, including after a rename.
        # O_NOFOLLOW is applied to EVERY component, not only the final filename.
        for part in parts[:-1]:
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        parent = os.fstat(directory)
        expected_parent = request['parentIdentity']
        if str(parent.st_dev) != expected_parent['dev'] or str(parent.st_ino) != expected_parent['ino']:
            raise RuntimeError('Approved parent directory changed; retry the tool')
        operation = request['operation']
        flags = os.O_NOFOLLOW | os.O_NONBLOCK
        if operation == 'Read':
            flags |= os.O_RDONLY
        elif operation == 'Write':
            flags |= os.O_WRONLY
        elif operation == 'Edit':
            flags |= os.O_RDWR
        else:
            raise RuntimeError('Unsupported native file operation')
        expected = request['identity']
        if expected is None:
            if operation != 'Write':
                raise RuntimeError('Approved file does not exist')
            file = os.open(parts[-1], flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        else:
            file = os.open(parts[-1], flags, dir_fd=directory)
        info = os.fstat(file)
        if expected is not None and (str(info.st_dev) != expected['dev'] or str(info.st_ino) != expected['ino']):
            raise RuntimeError('Approved file identity changed; retry the tool')
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError('Native tools require a regular file with no hard-link aliases')
        if operation != 'Write':
            limit = request['limit']
            data = bytearray()
            while len(data) <= limit:
                chunk = os.read(file, min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            if len(data) > limit:
                raise RuntimeError('File exceeds native read/edit size limit')
            content = data.decode('utf-8', errors='replace')
            if operation == 'Read':
                return content
            old = request['old_string']
            # Match the existing JS semantics, including overlapping occurrences.
            if content.find(old) < 0 or content.find(old) != content.rfind(old):
                raise RuntimeError('Edit requires exactly one matching occurrence')
            content = content.replace(old, request['new_string'], 1)
        else:
            content = request['content']
        data = content.encode('utf-8')
        os.lseek(file, 0, os.SEEK_SET)
        offset = 0
        while offset < len(data):
            written = os.write(file, data[offset:])
            if written <= 0:
                raise RuntimeError('Native file write made no progress')
            offset += written
        os.ftruncate(file, len(data))
        return 'File written' if operation == 'Write' else 'File edited'
    finally:
        if file is not None:
            os.close(file)
        os.close(directory)

try:
    print(json.dumps({'content': execute(json.load(sys.stdin)), 'is_error': False}))
except Exception as error:
    # OS errors may contain filenames, but never file contents or request payloads.
    print(json.dumps({'content': str(error), 'is_error': True}))
`;

export function executeNativeFileOperation(
  request: {
    operation: string;
    identity: { dev: string; ino: string } | null;
    parentIdentity: { dev: string; ino: string };
    file_path: string;
    limit: number;
    content?: string;
    old_string?: string;
    new_string?: string;
  },
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ content: string; is_error: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-I', '-c', helper],
      {
        // Ignore user/site Python configuration and do not inherit provider credentials.
        env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
        signal,
        timeout: timeoutMs,
        maxBuffer:
          request.operation === 'ListDirectory'
            ? 8 * 1024 * 1024
            : request.operation === 'ReadBytes'
              ? Math.ceil(request.limit / 3) * 4 + 1024
              : Math.max(1024 * 1024, request.limit * 12 + 1024),
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Native file helper unavailable, cancelled, or failed', { cause: error }),
          );
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout);
          if (
            !result ||
            typeof result !== 'object' ||
            !('content' in result) ||
            typeof result.content !== 'string' ||
            !('is_error' in result) ||
            typeof result.is_error !== 'boolean'
          )
            throw new Error('Invalid native file helper response');
          resolve({ content: result.content, is_error: result.is_error });
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin?.on('error', () => {
      /* execFile reports process failure. */
    });
    child.stdin?.end(JSON.stringify(request));
  });
}

export interface NativeReadIdentity {
  readonly dev: string;
  readonly ino: string;
}
export interface NativeReadAnchor {
  readonly rootPath: string;
  readonly identity: NativeReadIdentity;
}
export interface NativeAnchoredReadRequest {
  operation: 'ReadBytes' | 'ListDirectory' | 'ReadLink';
  /** Complete actual owner exclusions, never model input or inferred defaults. */
  deniedRoots: readonly string[];
  file_path: string;
  /** Actual owner-captured immutable root; never sourced from model intent. */
  rootAnchor: NativeReadAnchor;
  parentIdentity: NativeReadIdentity;
  identity: NativeReadIdentity;
  limit: number;
  maxEntries?: number;
  maxNameBytes?: number;
  expectedState?: { size: number; mtimeNs: string; ctimeNs: string };
  /** Trusted instruction projection only; callers must expose explicit truncation. */
  prefix?: boolean;
}

const validNativeReadPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length <= 4096 &&
  Buffer.byteLength(path) <= 4096 &&
  path.startsWith('/') &&
  !path.includes('\0') &&
  !path.includes('//') &&
  (path === '/' || !path.endsWith('/')) &&
  path.split('/').length <= 129 &&
  !path.split('/').some((part) => part === '.' || part === '..');
/** Private fact projection only; validates and copies, never confers authority. */
export function freezeNativeReadExclusions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256)
    throw Error('Actual read exclusions unavailable');
  let bytes = 0;
  for (const path of value) {
    if (!validNativeReadPath(path) || (bytes += Buffer.byteLength(path)) > 65536)
      throw Error('Actual read exclusions unavailable');
  }
  return Object.freeze([...value]);
}

/** Private filesystem primitive only. This is not a model tool or a grant. */
export async function executeNativeAnchoredReadOperation(
  request: NativeAnchoredReadRequest,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<{ content: string; is_error: boolean; truncated?: boolean }> {
  signal.throwIfAborted();
  const captured = {
    deniedRoots: request.deniedRoots,
    operation: request.operation,
    file_path: request.file_path,
    rootAnchor: {
      rootPath: request.rootAnchor?.rootPath,
      identity: { dev: request.rootAnchor?.identity?.dev, ino: request.rootAnchor?.identity?.ino },
    },
    identity: { dev: request.identity?.dev, ino: request.identity?.ino },
    parentIdentity: { dev: request.parentIdentity?.dev, ino: request.parentIdentity?.ino },
    limit: request.limit,
    maxEntries: request.maxEntries,
    maxNameBytes: request.maxNameBytes,
    prefix: request.prefix,
    expectedState:
      request.expectedState === undefined
        ? undefined
        : {
            size: request.expectedState.size,
            mtimeNs: request.expectedState.mtimeNs,
            ctimeNs: request.expectedState.ctimeNs,
          },
  };
  const bounded = (value: number | undefined, maximum: number) =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maximum;
  if (
    !validNativeReadPath(captured.file_path) ||
    !validNativeReadPath(captured.rootAnchor.rootPath) ||
    !['ReadBytes', 'ListDirectory', 'ReadLink'].includes(captured.operation) ||
    !bounded(captured.limit, 16 * 1024 * 1024) ||
    !bounded(timeoutMs, 30_000) ||
    (captured.operation === 'ReadLink' &&
      (!bounded(captured.limit, 4096) || captured.prefix !== undefined)) ||
    (captured.prefix !== undefined &&
      (typeof captured.prefix !== 'boolean' || captured.operation !== 'ReadBytes')) ||
    (captured.expectedState !== undefined &&
      (!Number.isSafeInteger(captured.expectedState.size) ||
        captured.expectedState.size < 0 ||
        !/^\d{1,32}$/.test(captured.expectedState.mtimeNs) ||
        !/^\d{1,32}$/.test(captured.expectedState.ctimeNs))) ||
    (captured.operation === 'ListDirectory' &&
      (!bounded(captured.maxEntries, 10000) || !bounded(captured.maxNameBytes, 1024 * 1024))) ||
    [captured.rootAnchor?.identity, captured.identity, captured.parentIdentity].some(
      (value) => !value || !/^\d{1,32}$/.test(value.dev) || !/^\d{1,32}$/.test(value.ino),
    )
  )
    return Promise.resolve({
      content: 'Invalid anchored read limits or authority',
      is_error: true,
    });
  let deniedRoots: readonly string[];
  try {
    deniedRoots = freezeNativeReadExclusions(captured.deniedRoots);
  } catch {
    return { content: 'Actual read exclusions unavailable', is_error: true };
  }
  if (
    deniedRoots.some(
      (root) =>
        captured.file_path === root ||
        captured.file_path.startsWith(root === '/' ? '/' : root + '/'),
    )
  )
    return { content: 'Anchored native read unavailable', is_error: true };
  const payload = { ...captured, deniedRoots, timeoutMs };
  const result = await executeNativeFileOperation(payload, signal, timeoutMs);
  signal.throwIfAborted();
  if (result.is_error)
    return {
      content: /^Anchored (directory|byte)( output)? limit exceeded$/.test(result.content)
        ? 'Anchored read limit exceeded'
        : 'Anchored native read unavailable',
      is_error: true,
    };
  if (!captured.prefix) return result;
  try {
    const value: unknown = JSON.parse(result.content);
    if (
      !value ||
      typeof value !== 'object' ||
      !('bytes' in value) ||
      typeof value.bytes !== 'string' ||
      !('truncated' in value) ||
      typeof value.truncated !== 'boolean'
    )
      throw Error('Invalid prefix');
    return { content: value.bytes, truncated: value.truncated, is_error: false };
  } catch {
    return { content: 'Anchored native read unavailable', is_error: true };
  }
}
