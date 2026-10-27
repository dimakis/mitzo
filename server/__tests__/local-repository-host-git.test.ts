import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  captureRepositoryHostGit,
  RepositoryHostProcessUncertainError,
} from '../local-repository-host-git.js';

const calls = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: calls.execute,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function fakeChild(stdout: string, stderr = '') {
  const child = Object.assign(new EventEmitter(), {
    pid: 1073741824,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', 0);
  });
  return child;
}

it('isolates Git config and only supplies the trusted GitHub helper in acquisition scratch', async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
  vi.stubEnv('GIT_CONFIG_VALUE_0', '!untrusted-source-helper');
  vi.stubEnv('GIT_SSH_COMMAND', 'untrusted-source-command');
  vi.stubEnv('GIT_DIR', '/other-task/.git');
  vi.stubEnv('GH_TOKEN', 'synthetic-fixture-token');
  calls.execute.mockImplementation(() =>
    fakeChild('public-result', 'credential-bearing diagnostic'),
  );
  const host = captureRepositoryHostGit();
  const result = await host.run(
    [
      '-c',
      'credential.helper=',
      '--git-dir',
      '/private/tmp/owned/acquire/.git',
      'fetch',
      '--no-tags',
      '--',
      'https://github.com/fixture/project.git',
      'refs/heads/main:refs/mitzo/base',
    ],
    {
      directory: '/private/tmp/owned/acquire',
      signal: new AbortController().signal,
      deadline: Date.now() + 30000,
    },
  );
  const [command, args, options] = calls.execute.mock.calls[0];
  expect(command).toBe('/usr/bin/git');
  expect(options.cwd).toBe('/private/tmp/owned');
  expect(options.env).toMatchObject({
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CEILING_DIRECTORIES: '/private/tmp/owned',
    GH_HOST: 'github.com',
  });
  for (const key of [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_SSH_COMMAND',
    'GIT_DIR',
  ])
    expect(options.env[key]).toBeUndefined();
  expect(args).toContain('credential.https://github.com.helper=!gh auth git-credential');
  expect(args).toContain('http.followRedirects=false');
  expect(args.join(' ')).not.toContain('synthetic-fixture-token');
  expect(result).toEqual({ stdout: 'public-result', stderr: '' });
});

it('redacts credential output and refuses an expired acquisition before a child is started', async () => {
  vi.stubEnv('GH_TOKEN', 'synthetic-fixture-token');
  calls.execute.mockImplementation(() => fakeChild('synthetic-fixture-token'));
  const host = captureRepositoryHostGit();
  const options = {
    directory: '/private/tmp/owned/acquire',
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
  };
  expect(
    await host.run(['ls-remote', '--', 'https://github.com/fixture/project.git'], options),
  ).toEqual({ stdout: '[REDACTED]', stderr: '' });
  await expect(host.run(['ls-remote'], { ...options, deadline: Date.now() - 1 })).rejects.toThrow(
    'expired',
  );
  expect(calls.execute).toHaveBeenCalledOnce();
});

const temporary: string[] = [];
const fixturePids: number[] = [];
afterEach(async () => {
  for (const pid of fixturePids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* The exact fixture process may already have exited. */
    }
  }
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});
const waitFor = async (action: () => Promise<boolean>) => {
  for (let index = 0; index < 100; index++) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Offline child fixture did not become ready');
};
async function processFixture(parentExits = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-host-process-')));
  temporary.push(root);
  const pidFile = join(root, 'child.pid'),
    marker = join(root, 'late-write');
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const program = `import os,signal,sys,time
pid=os.fork()
if pid==0:
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 open(sys.argv[1],'w').write(str(os.getpid()))
 os.close(1);os.close(2)
 time.sleep(0.6)
 open(sys.argv[2],'w').write('escaped writer')
 time.sleep(5)
else:
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 ${parentExits ? 'sys.exit(0)' : 'time.sleep(5)'}
`;
  calls.execute.mockImplementation((_command, _args, options) => {
    const child = actual.spawn('/usr/bin/python3', ['-I', '-c', program, pidFile, marker], options);
    if (child.pid) fixturePids.push(child.pid);
    return child;
  });
  return {
    root,
    pidFile,
    marker,
    host: captureRepositoryHostGit('https://git.example.test/team/repository.git'),
  };
}
it('joins the acquisition process group on abort before returning, including a SIGTERM-resistant writer', async () => {
  const f = await processFixture();
  const abort = new AbortController();
  const running = f.host.run(['ls-remote', '--', 'https://git.example.test/team/repository.git'], {
    directory: join(f.root, 'acquire'),
    signal: abort.signal,
    deadline: Date.now() + 10000,
  });
  const outcome = running.catch((error: unknown) => error);
  await waitFor(async () => {
    try {
      fixturePids.push(Number(await readFile(f.pidFile, 'utf8')));
      return true;
    } catch {
      return false;
    }
  });
  abort.abort();
  expect(await outcome).toBeInstanceOf(Error);
  await new Promise((resolve) => setTimeout(resolve, 750));
  await expect(access(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not report success while a child process can still write acquisition scratch', async () => {
  const f = await processFixture(true);
  const result = await f.host
    .run(['ls-remote', '--', 'https://git.example.test/team/repository.git'], {
      directory: join(f.root, 'acquire'),
      signal: new AbortController().signal,
      deadline: Date.now() + 10000,
    })
    .catch((error: unknown) => error);
  try {
    fixturePids.push(Number(await readFile(f.pidFile, 'utf8')));
  } catch {
    /* The exact fixture process may already have exited. */
  }
  expect(result).toBeInstanceOf(Error);
  await new Promise((resolve) => setTimeout(resolve, 750));
  await expect(access(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('joins timeout cancellation before a delayed writer can outlive the operation', async () => {
  const f = await processFixture();
  const result = await f.host
    .run(['ls-remote', '--', 'https://git.example.test/team/repository.git'], {
      directory: join(f.root, 'acquire'),
      signal: new AbortController().signal,
      deadline: Date.now() + 200,
    })
    .catch((error: unknown) => error);
  try {
    fixturePids.push(Number(await readFile(f.pidFile, 'utf8')));
  } catch {
    /* The exact fixture process may already have exited. */
  }
  expect(result).toBeInstanceOf(Error);
  await new Promise((resolve) => setTimeout(resolve, 750));
  await expect(access(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('requires scratch retention if the operation cannot establish process-group shutdown', async () => {
  calls.execute.mockImplementation(() => fakeChild('public-result'));
  const original = process.kill;
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -1073741824) throw Object.assign(Error('Unverified group'), { code: 'EPERM' });
    return original(pid, signal);
  });
  try {
    const result = await captureRepositoryHostGit()
      .run(['ls-remote', '--', 'https://github.com/fixture/project.git'], {
        directory: '/private/tmp/owned/acquire',
        signal: new AbortController().signal,
        deadline: Date.now() + 30000,
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RepositoryHostProcessUncertainError);
    expect((result as RepositoryHostProcessUncertainError).preserveScratch).toBe(true);
  } finally {
    kill.mockRestore();
  }
});
it('never gives a generic host GitHub credentials and restricts SSH to the agent without config or multiplexing', async () => {
  vi.stubEnv('GH_TOKEN', 'synthetic-fixture-token');
  vi.stubEnv('GH_CONFIG_DIR', '/private/github-config');
  vi.stubEnv('SSH_AUTH_SOCK', '/private/fixture-agent');
  calls.execute.mockImplementation(() => fakeChild('public-result'));
  await captureRepositoryHostGit('ssh://git@git.example.test/team/project.git').run(
    ['ls-remote', '--', 'ssh://git@git.example.test/team/project.git'],
    {
      directory: '/private/tmp/owned/acquire',
      signal: new AbortController().signal,
      deadline: Date.now() + 30000,
    },
  );
  const env = calls.execute.mock.calls[0][2].env;
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.GH_CONFIG_DIR).toBeUndefined();
  expect(env.SSH_AUTH_SOCK).toBe('/private/fixture-agent');
  expect(env.GIT_SSH_COMMAND).toContain('-F /dev/null');
  expect(env.GIT_SSH_COMMAND).toContain('-oIdentityFile=none');
  expect(env.GIT_SSH_COMMAND).toContain('-oControlMaster=no');
  expect(calls.execute.mock.calls[0][2]).toMatchObject({ detached: true });
  expect(calls.execute.mock.calls[0][2].signal).toBeUndefined();
});
