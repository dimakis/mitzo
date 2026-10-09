import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

// Python provides openat on supported hosts. Keep the asset in the compiled module.
// Request data travels over stdin; it never becomes Python source or shell input.
const helper = String.raw`
import json, os, stat, sys

MAX_BYTES = 128 * 1024 * 1024
MAX_ENTRIES = 100000
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def identity(info):
    return {'dev': str(info.st_dev), 'ino': str(info.st_ino)}

def same(info, expected):
    return identity(info) == expected

def open_directory(path):
    parts = path.split('/')
    if not path.startswith('/') or any(part in ('.', '..') for part in parts):
        raise RuntimeError('Invalid repository copy path')
    descriptor = os.open('/', DIRECTORY_FLAGS)
    try:
        for part in [part for part in parts if part]:
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise

def execute(request):
    if (os.open not in os.supports_dir_fd or os.mkdir not in os.supports_dir_fd
            or os.stat not in os.supports_dir_fd or os.listdir not in os.supports_fd):
        raise RuntimeError('Descriptor-relative repository copying is unavailable')
    source = open_directory(request['source'])
    parent = None
    destination = None
    try:
        parent = open_directory(request['parent'])
        source_info = os.fstat(source)
        parent_info = os.fstat(parent)
        if not same(source_info, request['sourceIdentity']) or not same(parent_info, request['parentIdentity']):
            raise RuntimeError('Repository task copy identity changed')
        if parent_info.st_mode & 0o077:
            raise RuntimeError('Repository task copy requires a private canonical container')
        name = request['name']
        if not name or name in ('.', '..') or '/' in name:
            raise RuntimeError('Invalid repository copy destination')
        os.mkdir(name, 0o700, dir_fd=parent)
        created = os.stat(name, dir_fd=parent, follow_symlinks=False)
        destination = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
        if not same(os.fstat(destination), identity(created)):
            raise RuntimeError('Repository task copy identity changed')
        destination_identity = identity(os.fstat(destination))
        # Roots pinned; copying stays descriptor-relative.
        counts = {'entries': 0, 'bytes': 0}

        def copy_directory(source_fd, destination_fd):
            directory_info = os.fstat(source_fd)
            for entry in sorted(os.listdir(source_fd)):
                counts['entries'] += 1
                if counts['entries'] > MAX_ENTRIES:
                    raise RuntimeError('Repository copy exceeds supported bounds')
                before = os.stat(entry, dir_fd=source_fd, follow_symlinks=False)
                if stat.S_ISDIR(before.st_mode):
                    child_source = os.open(entry, DIRECTORY_FLAGS, dir_fd=source_fd)
                    child_destination = None
                    try:
                        if not same(os.fstat(child_source), identity(before)):
                            raise RuntimeError('Repository source changed while copying')
                        os.mkdir(entry, 0o700, dir_fd=destination_fd)
                        child_created = os.stat(entry, dir_fd=destination_fd, follow_symlinks=False)
                        child_destination = os.open(entry, DIRECTORY_FLAGS, dir_fd=destination_fd)
                        if not same(os.fstat(child_destination), identity(child_created)):
                            raise RuntimeError('Repository task copy identity changed')
                        # Nested roots pinned; copying stays descriptor-relative.
                        copy_directory(child_source, child_destination)
                        if not same(os.stat(entry, dir_fd=source_fd, follow_symlinks=False), identity(before)):
                            raise RuntimeError('Repository source changed while copying')
                        if not same(os.stat(entry, dir_fd=destination_fd, follow_symlinks=False), identity(child_created)):
                            raise RuntimeError('Repository task copy identity changed')
                    finally:
                        if child_destination is not None:
                            os.close(child_destination)
                        os.close(child_source)
                elif stat.S_ISREG(before.st_mode) and before.st_nlink == 1:
                    # Open only the inspected source file.
                    source_file = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
                    destination_file = None
                    try:
                        opened = os.fstat(source_file)
                        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                                or not same(opened, identity(before)) or opened.st_size != before.st_size
                                or opened.st_mtime_ns != before.st_mtime_ns):
                            raise RuntimeError('Repository source changed while copying')
                        destination_file = os.open(entry, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                                   0o600, dir_fd=destination_fd)
                        while True:
                            chunk = os.read(source_file, min(65536, MAX_BYTES - counts['bytes'] + 1))
                            if not chunk:
                                break
                            counts['bytes'] += len(chunk)
                            if counts['bytes'] > MAX_BYTES:
                                raise RuntimeError('Repository copy exceeds supported bounds')
                            offset = 0
                            while offset < len(chunk):
                                written = os.write(destination_file, chunk[offset:])
                                if written <= 0:
                                    raise RuntimeError('Repository copy write made no progress')
                                offset += written
                        after = os.fstat(source_file)
                        if (not same(after, identity(opened)) or after.st_size != opened.st_size
                                or after.st_mtime_ns != opened.st_mtime_ns or after.st_nlink != 1
                                or not same(os.stat(entry, dir_fd=source_fd, follow_symlinks=False), identity(opened))):
                            raise RuntimeError('Repository source changed while copying')
                        os.fchmod(destination_file, stat.S_IMODE(opened.st_mode))
                    finally:
                        if destination_file is not None:
                            os.close(destination_file)
                        os.close(source_file)
                else:
                    raise RuntimeError('Repository source storage is unsupported')
            os.fchmod(destination_fd, stat.S_IMODE(directory_info.st_mode))

        copy_directory(source, destination)
        return destination_identity
    finally:
        if destination is not None:
            os.close(destination)
        if parent is not None:
            os.close(parent)
        os.close(source)

try:
    print(json.dumps({'ok': True, 'destinationIdentity': execute(json.load(sys.stdin))}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
`;

type DirectoryIdentity = { dev: string; ino: string };
const identity = (value: { dev: bigint; ino: bigint }): DirectoryIdentity => ({
  dev: value.dev.toString(),
  ino: value.ino.toString(),
});
const sameIdentity = (value: { dev: bigint; ino: bigint }, expected: DirectoryIdentity) =>
  value.dev.toString() === expected.dev && value.ino.toString() === expected.ino;

/** Copy exclusively beneath pinned directory descriptors; failed copies retain their claim. */
export async function copyRepositoryTaskCheckout(
  source: string,
  destination: string,
  signal: AbortSignal = AbortSignal.timeout(30000),
) {
  signal.throwIfAborted();
  const parent = dirname(destination);
  const container = await lstat(parent, { bigint: true });
  if (
    resolve(destination) !== destination ||
    (await realpath(parent)) !== parent ||
    !container.isDirectory() ||
    (container.mode & 0o077n) !== 0n
  )
    throw new Error('Repository task copy requires a private canonical container');
  const sourceInfo = await lstat(source, { bigint: true });
  if ((await realpath(source)) !== source || !sourceInfo.isDirectory())
    throw new Error('Prepared repository source identity changed');
  const sourceIdentity = identity(sourceInfo),
    parentIdentity = identity(container);
  const destinationIdentity = await new Promise<DirectoryIdentity>((resolveCopy, reject) => {
    const child = execFile(
      'python3',
      ['-I', '-c', helper],
      {
        env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
        signal,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Repository copy helper unavailable, cancelled, or failed', { cause: error }),
          );
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout);
          if (!result || typeof result !== 'object' || !('ok' in result))
            throw new Error('Invalid repository copy helper response');
          if (result.ok !== true)
            throw new Error(
              'error' in result && typeof result.error === 'string'
                ? result.error
                : 'Repository copy failed',
            );
          if (
            !('destinationIdentity' in result) ||
            !result.destinationIdentity ||
            typeof result.destinationIdentity !== 'object'
          )
            throw new Error('Invalid repository copy helper identity');
          const retained = result.destinationIdentity;
          if (
            !('dev' in retained) ||
            !('ino' in retained) ||
            typeof retained.dev !== 'string' ||
            typeof retained.ino !== 'string' ||
            !/^\d+$/.test(retained.dev) ||
            !/^\d+$/.test(retained.ino)
          )
            throw new Error('Invalid repository copy helper identity');
          resolveCopy({ dev: retained.dev, ino: retained.ino });
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin?.on('error', () => {
      // execFile reports a failed or cancelled helper.
    });
    child.stdin?.end(
      JSON.stringify({
        source,
        parent,
        name: basename(destination),
        sourceIdentity,
        parentIdentity,
      }),
    );
  });
  try {
    const [retainedSource, retainedDestination, retainedParent] = await Promise.all([
      lstat(source, { bigint: true }),
      lstat(destination, { bigint: true }),
      lstat(parent, { bigint: true }),
    ]);
    if (
      (await realpath(source)) !== source ||
      (await realpath(destination)) !== destination ||
      (await realpath(parent)) !== parent ||
      !retainedSource.isDirectory() ||
      !retainedDestination.isDirectory() ||
      !retainedParent.isDirectory() ||
      !sameIdentity(retainedSource, sourceIdentity) ||
      !sameIdentity(retainedDestination, destinationIdentity) ||
      !sameIdentity(retainedParent, parentIdentity)
    )
      throw new Error('Retained directory identity does not match');
  } catch (error) {
    throw new Error('Repository task copy identity changed', { cause: error });
  }
}
