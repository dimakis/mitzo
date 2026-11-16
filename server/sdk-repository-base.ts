import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localRepositoryRemote } from './local-repository-base.js';
import { assertLocalRepository, type LocalRepositorySource } from './local-repository-worktree.js';
import { executeSandboxedCommand } from './sandboxed-command.js';
import { isGitBranchName } from './git-branch.js';
import { readOnlyGitExecutable } from './read-only-git.js';
import { joinRetainedFinalizers } from './retained-finalization.js';
import { retainedCallbackOutcome } from './turn-callbacks.js';
import { createLogger } from './logger.js';

const execute = promisify(execFile);
const log = createLogger('sdk-repository-base');
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// Read only the approved source's physical config. Includes and helpers are
// data, never controller configuration. Root replacement and every link fail.
const readConfig = `
import json, os, stat, sys
root, device, inode = json.loads(sys.argv[1])
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
        raise RuntimeError('Source repository identity changed')
    config = os.open('config', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(config)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            raise RuntimeError('Source configuration unavailable')
        data = os.read(config, 65537)
        if len(data) > 65536: raise RuntimeError('Source configuration too large')
        sys.stdout.buffer.write(data)
    finally: os.close(config)
finally: os.close(fd)
`;

/** Fetch with generated bare configuration, no source helpers or controller
 * credentials. Only the trusted fetch may append Git-addressed objects to the
 * source store; source refs/config/worktree remain outside its write grant. */
export async function captureSdkRepositoryDefaultBase(
  source: LocalRepositorySource,
  signal: AbortSignal,
  assertCurrent: () => Promise<void>,
) {
  await assertCurrent();
  signal.throwIfAborted();
  const { stdout: config } = await execute(
    '/usr/bin/python3',
    [
      '-I',
      '-c',
      readConfig,
      JSON.stringify([
        source.commonDirectory,
        String(source.commonRoot.dev),
        String(source.commonRoot.ino),
      ]),
    ],
    { signal, timeout: 5000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' } },
  );
  const remote = await localRepositoryRemote(config);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'sdk-base-')));
  let failure: { cause: unknown } | undefined;
  let preserveScratch = false;
  const objectDirectory = join(source.commonDirectory, 'objects');
  const gitDirectory = join(scratch, 'bare');
  const run = async (args: string[], objects = false) => {
    await assertCurrent();
    const environment = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_SSH_COMMAND:
        '/usr/bin/ssh -F /dev/null -oBatchMode=yes -oIdentityFile=none -oForwardAgent=no -oClearAllForwardings=yes',
      ...(objects ? { GIT_OBJECT_DIRECTORY: objectDirectory } : {}),
    };
    const command = [
      '/usr/bin/env',
      ...Object.entries(environment).map(([k, v]) => `${k}=${v}`),
      readOnlyGitExecutable(),
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'credential.helper=',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'http.followRedirects=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.ssh.allow=always',
      ...args,
    ]
      .map(quote)
      .join(' ');
    const result = await executeSandboxedCommand({
      command,
      cwd: scratch,
      writableRoots: [scratch],
      additionalWritePaths: objects ? [objectDirectory] : [],
      deniedRoots: [],
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin' },
      networkAccess: 'approved-command',
      signal,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      privateOutput: 'separate',
      beforeSpawnAsync: assertCurrent,
    });
    if (retainedCallbackOutcome(result) === 'unknown') {
      preserveScratch = true;
      throw Object.assign(
        Error(
          `Default-base acquisition outcome is uncertain; preserve and inspect ${scratch} before retrying.`,
        ),
        { preserveScratch: true },
      );
    }
    if (result.isError || typeof result.stdout !== 'string')
      throw Error(
        'Default-base acquisition failed. Use native git fetch in the admitted checkout and explicitly select the fetched ref.',
        { cause: Error(result.stderr || result.content) },
      );
    await assertCurrent();
    signal.throwIfAborted();
    return result.stdout.trim();
  };
  try {
    const head = await run(['ls-remote', '--symref', '--', remote, 'HEAD']);
    const ref = /^ref: (refs\/heads\/[^\t\r\n]+)\tHEAD$/m.exec(head)?.[1];
    if (!ref || !isGitBranchName(ref)) throw Error('Remote default branch unavailable');
    const objectFormat = /^[a-f0-9]{64}\tHEAD$/m.test(head) ? 'sha256' : 'sha1';
    await run([
      'init',
      '--bare',
      '--quiet',
      '--template=',
      `--object-format=${objectFormat}`,
      gitDirectory,
    ]);
    await run(
      [
        '--git-dir',
        gitDirectory,
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--',
        remote,
        `+${ref}:refs/mitzo/base`,
      ],
      true,
    );
    const baseOid = await run(
      [
        '--git-dir',
        gitDirectory,
        'rev-parse',
        '--verify',
        '--end-of-options',
        'refs/mitzo/base^{commit}',
      ],
      true,
    );
    assertLocalRepository(source, source.path, baseOid);
    return { baseOid, baseBranch: ref.slice('refs/heads/'.length) };
  } catch (cause) {
    failure = { cause };
    log.warn('SDK default-base acquisition failed', {
      code: 'SDK_REPOSITORY_BASE_FAILED',
      stage: 'acquisition',
      repositoryId: source.repositoryId,
      preserveScratch,
    });
    throw cause;
  } finally {
    if (!preserveScratch)
      await joinRetainedFinalizers(
        'sdk_repository_base',
        [() => rm(scratch, { recursive: true, force: true })],
        failure,
      );
  }
}
