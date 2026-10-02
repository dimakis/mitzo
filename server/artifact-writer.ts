import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { OpenShellRuntime } from './openshell-runtime.js';
import {
  OPEN_SHELL_ARTIFACT_HELPER,
  OpenShellArtifactReadError,
} from './openshell-artifact-reader.js';

// Reuse exactly the read helper's path, byte and file-identity protections.
export const ARTIFACT_WRITE_HELPER =
  OPEN_SHELL_ARTIFACT_HELPER.split('\ntry:\n result=read')[0] +
  String.raw`
import fcntl, secrets
def stamp(value):
 return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)
def write(root, requested, payload):
 if not isinstance(payload,dict) or not isinstance(payload.get('content'),str) or not isinstance(payload.get('expectedContent'),str): refuse('invalid')
 replacement=payload['content'].encode('utf-8'); original=payload['expectedContent'].encode('utf-8')
 if len(replacement)>LIMIT or len(original)>LIMIT: refuse('too_large')
 file=read(root,requested)
 full=file['path']; parts=full.strip('/').split('/'); fds=[]; temporary=None
 try:
  flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
  parent=os.open('/',flags); fds.append(parent)
  for part in parts[:-1]:
   parent=os.open(part,flags,dir_fd=parent); fds.append(parent)
  fcntl.flock(parent,fcntl.LOCK_EX)
  before=os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
  if base64.b64decode(read(root,requested)['data'])!=original: refuse('conflict')
  temporary='.mitzo-edit-'+secrets.token_hex(16)
  fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent); fds.append(fd)
  os.fchmod(fd,stat.S_IMODE(before.st_mode)&0o777)
  view=memoryview(replacement)
  while view:
   count=os.write(fd,view); view=view[count:]
  os.fsync(fd)
  if stamp(before)!=stamp(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)): refuse('conflict')
  os.rename(temporary,parts[-1],src_dir_fd=parent,dst_dir_fd=parent); temporary=None
  return {'path':full,'ok':True}
 finally:
  if temporary is not None:
   try: os.unlink(temporary,dir_fd=parent)
   except OSError: pass
  for fd in reversed(fds): os.close(fd)
try:
 raw=sys.stdin.read(64*1024*1024+1)
 if len(raw)>64*1024*1024: refuse('too_large')
 result=write(sys.argv[1],sys.argv[2],json.loads(raw))
except Refusal as error: result={'error':str(error)}
except FileNotFoundError: result={'error':'not_found'}
except (ValueError,UnicodeError): result={'error':'invalid'}
except OSError as error: result={'error':'forbidden' if error.errno in (errno.ELOOP,errno.ENOTDIR,errno.EACCES,errno.EPERM) else 'unavailable'}
print(json.dumps(result))
`;
export type ArtifactWriteRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  input: string,
) => Promise<string>;
const command: ArtifactWriteRunner = (program, args, env, signal, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      program,
      [...args],
      { env, signal, timeout: 20_000, maxBuffer: 65536, encoding: 'utf8' },
      (error, stdout) => {
        if (error)
          reject(
            new OpenShellArtifactReadError(
              503,
              'Save could not be confirmed. Reopen the document to check its contents.',
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {
      /* Process exit is handled by execFile. */
    });
    child.stdin?.end(input);
  });
export async function writeOpenShellArtifact(
  runtime: OpenShellRuntime & { sandboxId: string },
  requestedPath: string,
  content: string,
  expectedContent: string,
  verifyIdentity: () => Promise<void>,
  signal = AbortSignal.timeout(30_000),
  run: ArtifactWriteRunner = command,
): Promise<{ path: string; bytes: Buffer }> {
  const spec = openShellSshArgvProcessSpec(runtime, [
    '/usr/bin/python3',
    '-I',
    '-c',
    ARTIFACT_WRITE_HELPER,
    runtime.workdir,
    requestedPath,
  ]);
  await verifyIdentity();
  try {
    const value = JSON.parse(
      await run(
        spec.command,
        spec.args,
        spec.env,
        signal,
        JSON.stringify({ content, expectedContent }),
      ),
    );
    if (value.error) {
      const status =
        (
          {
            conflict: 409,
            forbidden: 403,
            not_found: 404,
            not_file: 400,
            too_large: 413,
            invalid: 400,
          } as Record<string, number>
        )[value.error] || 503;
      throw new OpenShellArtifactReadError(
        status,
        value.error === 'conflict'
          ? 'File changed elsewhere. Your draft is preserved; reopen the document to review the latest version.'
          : 'Sandbox document could not be saved. Your draft is preserved.',
      );
    }
    const expected = posix.resolve(runtime.workdir, requestedPath);
    if (!value.ok || value.path !== expected || !expected.startsWith(`${runtime.workdir}/`))
      throw Error('Invalid save receipt');
    await verifyIdentity();
    return { path: expected, bytes: Buffer.alloc(0) };
  } catch (error) {
    if (error instanceof OpenShellArtifactReadError) throw error;
    throw new OpenShellArtifactReadError(
      503,
      'Save could not be confirmed. Reopen the document to check its contents.',
    );
  }
}
