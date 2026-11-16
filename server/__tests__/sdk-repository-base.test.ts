import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, access, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = vi.hoisted(() => vi.fn());
vi.mock('../sandboxed-command.js', () => ({ executeSandboxedCommand: run }));
import { captureLocalRepository } from '../local-repository-worktree.js';
import { captureSdkRepositoryDefaultBase } from '../sdk-repository-base.js';
import { retainCallbackOutcome, TurnCallbacks } from '../turn-callbacks.js';
import { reportToolFailure } from '../tool-failure-reporting.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  run.mockReset();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sdk-base-test-')));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--template=', '-b', 'main');
  git(
    '-c',
    'user.name=Offline',
    '-c',
    'user.email=offline@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  );
  git('config', 'remote.origin.url', 'https://example.invalid/repository');
  git('config', 'credential.helper', '!touch /must-never-run');
  git('config', 'http.cookieFile', '/must-never-read');
  return captureLocalRepository('source', root, new AbortController().signal, 'HEAD');
}
it('refreshes the remote default in isolated configuration and grants only source object appends', async () => {
  const f = await fixture();
  const current = vi.fn().mockResolvedValue(undefined);
  run.mockImplementation(async (options) => ({
    isError: false,
    stderr: '',
    stdout: options.command.includes("'ls-remote'")
      ? `ref: refs/heads/main\tHEAD\n${f.baseOid}\tHEAD\n`
      : options.command.includes("'rev-parse'")
        ? f.baseOid
        : '',
  }));
  expect(
    await captureSdkRepositoryDefaultBase(f.localSource, new AbortController().signal, current),
  ).toEqual({ baseOid: f.baseOid, baseBranch: 'main' });
  const calls = run.mock.calls.map(([options]) => options);
  expect(calls).toHaveLength(4);
  for (const options of calls) {
    expect(options.cwd).not.toBe(f.localSource.path);
    expect(options.command).not.toContain('/must-never-run');
    expect(options.command).not.toContain('/must-never-read');
    expect(options.beforeSpawnAsync).toBe(current);
    expect(options.writableRoots).toEqual([options.cwd]);
    expect(
      options.additionalWritePaths.every(
        (path: string) => path === join(f.localSource.commonDirectory, 'objects'),
      ),
    ).toBe(true);
  }
  expect(calls[2].command).toContain("'fetch'");
  expect(calls[2].command).toContain('GIT_OBJECT_DIRECTORY=');
  expect(calls[2].command).toContain("'credential.helper='");
  expect(calls[2].command).toContain("'--git-dir'");
});
it('preserves the acquisition scratch when command termination is uncertain', async () => {
  const f = await fixture();
  run.mockResolvedValue(
    retainCallbackOutcome({ isError: true, content: 'unknown', stderr: '', stdout: '' }, 'unknown'),
  );
  await expect(
    captureSdkRepositoryDefaultBase(f.localSource, new AbortController().signal, async () => {}),
  ).rejects.toMatchObject({ preserveScratch: true });
  const scratch = run.mock.calls[0][0].cwd;
  roots.push(scratch); // No real subprocess was started by this mock.
  await expect(access(scratch)).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledOnce();
});
it('settles a confirmed acquisition refusal through tool reporting without bricking the turn', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  run.mockResolvedValue(
    retainCallbackOutcome(
      { isError: true, content: '', stderr: 'remote access refused', stdout: '' },
      'settled',
    ),
  );
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  const result = await callbacks.track(async () => {
    try {
      await captureSdkRepositoryDefaultBase(f.localSource, signal, async () => {});
      throw Error('Expected acquisition refusal');
    } catch (cause) {
      return reportToolFailure(cause, {
        sessionId: 'default-base',
        tool: 'PrepareLocalRepository',
        signal,
      });
    }
  });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content).diagnostic).toMatchObject({
    stage: 'repository_preparation',
    effectStatus: 'completed',
  });
  await expect(callbacks.settle(signal)).resolves.toBeUndefined();
});
it('fetches a new remote commit into the source object store without executing source configuration or changing source HEAD', async () => {
  const f = await fixture();
  const remote = await realpath(await mkdtemp(join(tmpdir(), 'sdk-base-remote-')));
  roots.push(remote);
  execFileSync('git', ['clone', '-q', '--no-local', f.localSource.path, remote]);
  await writeFile(join(remote, 'remote.txt'), 'fresh remote content');
  execFileSync('git', ['-C', remote, 'add', 'remote.txt']);
  execFileSync('git', [
    '-C',
    remote,
    '-c',
    'user.name=Offline',
    '-c',
    'user.email=offline@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fresh',
  ]);
  const oid = execFileSync('git', ['-C', remote, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const execute = promisify(execFile);
  run.mockImplementation(async (options) => {
    // Substitute only the network transfer with a fixture-local repository.
    // All generated Git commands, isolated configuration and object writes run.
    const command = options.command
      .replaceAll("'https://example.invalid/repository'", "'" + remote + "'")
      .replace(
        "'protocol.allow=never'",
        "'protocol.allow=never' '-c' 'protocol.file.allow=always'",
      );
    await options.beforeSpawnAsync();
    const result = await execute('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 5000,
    });
    return { ...result, isError: false, content: '' };
  });
  expect(
    await captureSdkRepositoryDefaultBase(
      f.localSource,
      new AbortController().signal,
      async () => {},
    ),
  ).toEqual({ baseOid: oid, baseBranch: 'main' });
  expect(
    execFileSync('git', ['-C', f.localSource.path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe(f.baseOid);
  expect(
    execFileSync('git', ['-C', f.localSource.path, 'show', oid + ':remote.txt'], {
      encoding: 'utf8',
    }),
  ).toBe('fresh remote content');
});
