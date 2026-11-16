import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Fixed program only. Every component is opened without following links, and
 * the approved root's identity is checked before any descriptor-relative mkdir.
 * SRT's command-directory protection remains intact for all Git subprocesses. */
const program = `
import json, os, sys
root, suffix, device, inode = json.loads(sys.argv[1])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open('/', flags)
try:
    for part in root.split('/'):
        if not part: continue
        child = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = child
    info = os.fstat(fd)
    if str(info.st_dev) != device or str(info.st_ino) != inode:
        raise RuntimeError('Approved repository directory identity changed')
    for part in suffix.split('/'):
        if part in ('', '.', '..'): raise RuntimeError('Invalid repository directory')
        try: os.mkdir(part, mode=0o700, dir_fd=fd)
        except FileExistsError: pass
        child = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = child
finally:
    os.close(fd)
`;

export async function createSdkRepositoryDirectory(
  root: string,
  path: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const suffix = relative(root, path);
  if (!isAbsolute(root) || !suffix || isAbsolute(suffix) || suffix.split(sep).includes('..'))
    throw Error('Repository directory is outside its approved root');
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory()) throw Error('Approved repository root must be a physical directory');
  await execute(
    '/usr/bin/python3',
    ['-I', '-c', program, JSON.stringify([root, suffix, info.dev.toString(), info.ino.toString()])],
    { signal, timeout: 30_000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin' } },
  );
  signal.throwIfAborted();
}
