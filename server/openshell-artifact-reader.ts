import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { OpenShellRuntime } from './openshell-runtime.js';

const MAX_BYTES = 5 * 1024 * 1024;
export class OpenShellArtifactReadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type ArtifactCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<string>;

/** Code-owned helper: descriptor-relative no-follow reads, never a shell command. */
export const OPEN_SHELL_ARTIFACT_HELPER = String.raw`
import os, sys, stat, json, base64, errno
LIMIT = 5 * 1024 * 1024
class Refusal(Exception): pass
def refuse(reason): raise Refusal(reason)
def private(parts):
 return any(p in ('.codex','.ssh','.aws','.cursor','.docker','.kube','.mitzo','.claude','.claude.json','.config','.git','.netrc','.npmrc','.pypirc','.git-credentials','auth.json','credentials.json') or p.startswith('.env') or p.startswith('credential') for p in parts)
def read(root, requested):
 if not root.startswith('/') or root != os.path.normpath(root): refuse('forbidden')
 if not requested or '\\' in requested or any(ord(c)<32 or ord(c)==127 for c in requested): refuse('forbidden')
 if '..' in requested.split('/'): refuse('forbidden')
 full = os.path.normpath(requested if requested.startswith('/') else os.path.join(root, requested))
 if not full.startswith(root + '/'): refuse('forbidden')
 parts = full[len(root)+1:].split('/')
 if private(parts): refuse('forbidden')
 fds = []
 try:
  directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
  fd = os.open('/', directory_flags); fds.append(fd)
  for part in root.strip('/').split('/') + parts[:-1]:
   fd = os.open(part, directory_flags, dir_fd=fd); fds.append(fd)
  fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd); fds.append(fd)
  before = os.fstat(fd)
  if not stat.S_ISREG(before.st_mode): refuse('not_file')
  if before.st_nlink != 1: refuse('forbidden')
  if before.st_size > LIMIT: refuse('too_large')
  chunks=[]; total=0
  while True:
   chunk=os.read(fd, min(65536, LIMIT + 1 - total))
   if not chunk: break
   chunks.append(chunk); total+=len(chunk)
   if total>LIMIT: refuse('too_large')
  after=os.fstat(fd)
  if (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns,before.st_nlink) != (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_nlink) or total != after.st_size: refuse('unavailable')
  return {'path':full,'data':base64.b64encode(b''.join(chunks)).decode('ascii')}
 finally:
  for fd in reversed(fds): os.close(fd)
try:
 result=read(sys.argv[1],sys.argv[2])
except Refusal as error: result={'error':str(error)}
except FileNotFoundError: result={'error':'not_found'}
except OSError as error: result={'error':'forbidden' if error.errno in (errno.ELOOP,errno.ENOTDIR,errno.EACCES,errno.EPERM) else 'unavailable'}
print(json.dumps(result))
`;

const command: ArtifactCommandRunner = (program, args, env, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      program,
      [...args],
      {
        env,
        signal,
        timeout: 15_000,
        maxBuffer: Math.ceil((MAX_BYTES * 4) / 3) + 65536,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) reject(new OpenShellArtifactReadError(503, 'Sandbox artifact unavailable'));
        else resolve(stdout);
      },
    );
  });

/** Read only from an already available sandbox selected by persisted server authority. */
export async function readOpenShellArtifact(
  runtime: OpenShellRuntime & { sandboxId: string },
  requestedPath: string,
  verifyIdentity: () => Promise<void>,
  signal = AbortSignal.timeout(30_000),
  run: ArtifactCommandRunner = command,
): Promise<{ path: string; bytes: Buffer }> {
  // This validates all transport selectors and quotes each opaque argument once.
  const spec = openShellSshArgvProcessSpec(runtime, [
    '/usr/bin/python3',
    '-I',
    '-c',
    OPEN_SHELL_ARTIFACT_HELPER,
    runtime.workdir,
    requestedPath,
  ]);
  await verifyIdentity();
  let result: { path: string; bytes: Buffer };
  try {
    const response: unknown = JSON.parse(await run(spec.command, spec.args, spec.env, signal));
    if (!response || typeof response !== 'object') throw new Error('Invalid artifact response');
    const value = response as Record<string, unknown>;
    if (value.error) {
      const status = { forbidden: 403, not_found: 404, not_file: 400, too_large: 413 }[
        String(value.error)
      ];
      throw new OpenShellArtifactReadError(status ?? 503, 'Sandbox artifact unavailable');
    }
    const expected = posix.resolve(runtime.workdir, requestedPath);
    if (
      value.path !== expected ||
      !expected.startsWith(`${runtime.workdir}/`) ||
      typeof value.data !== 'string'
    )
      throw new Error('Invalid artifact response');
    if (value.data.length > Math.ceil(MAX_BYTES / 3) * 4)
      throw new OpenShellArtifactReadError(413, 'File is too large (5 MB maximum)');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.toString('base64') !== value.data) throw new Error('Invalid artifact response');
    if (bytes.length > MAX_BYTES)
      throw new OpenShellArtifactReadError(413, 'File is too large (5 MB maximum)');
    result = { path: expected, bytes };
  } catch (error) {
    if (error instanceof OpenShellArtifactReadError) throw error;
    throw new OpenShellArtifactReadError(503, 'Sandbox artifact unavailable');
  }
  await verifyIdentity();
  return result;
}
