import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
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
import os, sys, stat, json, base64, errno, hashlib
LIMIT = 5 * 1024 * 1024
class Refusal(Exception): pass
def refuse(reason): raise Refusal(reason)
def private(parts):
 return any(p in ('.codex','.ssh','.aws','.cursor','.docker','.kube','.mitzo','.claude','.claude.json','.config','.git','.netrc','.npmrc','.pypirc','.git-credentials','auth.json','credentials.json') or p.startswith('.env') or p.startswith('credential') for p in parts)
def stamp(info):
 return [str(info.st_dev),str(info.st_ino),str(info.st_uid),str(info.st_mode)]
def file_stamp(info):
 return stamp(info)+[str(info.st_size),str(info.st_mtime_ns),str(info.st_ctime_ns),str(info.st_nlink)]
def read(root, requested, witnessed=False):
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
  root_parts=root.strip('/').split('/')
  root_info=os.fstat(fd)
  for index,part in enumerate(root_parts + parts[:-1]):
   fd = os.open(part, directory_flags, dir_fd=fd); fds.append(fd)
   if index+1==len(root_parts): root_info=os.fstat(fd)
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
  data=b''.join(chunks)
  result={'path':full,'data':base64.b64encode(data).decode('ascii')}
  if witnessed:
   # Rewalk the actual namespace after reading, not just the held descriptors.
   check=os.open('/',directory_flags); fds.append(check)
   check_root=os.fstat(check)
   for index,part in enumerate(root_parts + parts[:-1]):
    check=os.open(part,directory_flags,dir_fd=check); fds.append(check)
    if index+1==len(root_parts): check_root=os.fstat(check)
   check=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=check); fds.append(check)
   if stamp(check_root)!=stamp(root_info) or file_stamp(os.fstat(check))!=file_stamp(after): refuse('unavailable')
   result['witness']={'root':stamp(root_info),'file':file_stamp(after),'sha256':hashlib.sha256(data).hexdigest()}
  return result
 finally:
  for fd in reversed(fds): os.close(fd)
try:
 result=read(sys.argv[1],sys.argv[2],len(sys.argv)>3 and sys.argv[3]=='witness')
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

const stampPart = z.string().regex(/^\d+$/).max(32);
const localObservation = z.strictObject({
  path: z.string().max(4096),
  data: z.string().max(Math.ceil(MAX_BYTES / 3) * 4),
  witness: z.strictObject({
    root: z.tuple([stampPart, stampPart, stampPart, stampPart]),
    file: z.tuple([
      stampPart,
      stampPart,
      stampPart,
      stampPart,
      stampPart,
      stampPart,
      stampPart,
      stampPart,
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

/** Private Local composition of the existing bounded reader. Root data must
 * come from the actual admitted owner; this function grants no path authority.
 * The returned final custody renewal performs no supplied authority callbacks. */
export async function captureLocalArtifactFile(
  root: string,
  requestedPath: string,
  assertHostCurrentSync: () => void,
  signal = AbortSignal.timeout(30_000),
  run: ArtifactCommandRunner = command,
) {
  const unavailable = () =>
    new OpenShellArtifactReadError(409, 'Original workspace file changed or is unavailable');
  if (
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    root.length > 4096 ||
    requestedPath.length > 4096
  )
    throw unavailable();
  const expected = posix.resolve(root, requestedPath);
  const args = ['-I', '-c', OPEN_SHELL_ARTIFACT_HELPER, root, requestedPath, 'witness'];
  const assertHost = () => {
    signal.throwIfAborted();
    const result: unknown = assertHostCurrentSync();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw unavailable();
    }
  };
  const parse = (stdout: string) => {
    const parsed = localObservation.safeParse(JSON.parse(stdout));
    if (!parsed.success || parsed.data.path !== expected || !expected.startsWith(root + '/'))
      throw unavailable();
    const bytes = Buffer.from(parsed.data.data, 'base64');
    if (
      bytes.length > MAX_BYTES ||
      bytes.toString('base64') !== parsed.data.data ||
      createHash('sha256').update(bytes).digest('hex') !== parsed.data.witness.sha256
    )
      throw unavailable();
    return { bytes, witness: parsed.data.witness };
  };
  assertHost();
  const stdout = await run('python3', args, process.env, signal);
  assertHost();
  const original = parse(stdout);
  const bytes = Buffer.from(original.bytes);
  const sha256 = original.witness.sha256;
  const assertCurrentSync = () => {
    signal.throwIfAborted();
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw unavailable();
    let current: ReturnType<typeof parse>;
    try {
      current = parse(
        execFileSync('python3', args, {
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: Math.ceil((MAX_BYTES * 4) / 3) + 65536,
        }),
      );
    } catch {
      throw unavailable();
    }
    if (!isDeepStrictEqual(current.witness, original.witness)) throw unavailable();
  };
  // A final host callback cannot silently replace the file observed by the
  // asynchronous reader. Later owners repeat this witness after their callbacks.
  assertCurrentSync();
  return Object.freeze({ path: expected, bytes, sha256, assertCurrentSync });
}

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
