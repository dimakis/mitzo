import { execFile } from 'node:child_process';

// Python exposes openat via dir_fd on macOS/Linux. Node has no equivalent API.
// Keep the helper embedded so tsc/deploy cannot omit a required runtime asset.
// No user text is interpolated into source or argv: the request travels over stdin.
const helper = String.raw`
import json, os, stat, sys

def execute(request):
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
        maxBuffer: Math.max(1024 * 1024, request.limit * 12 + 1024),
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
