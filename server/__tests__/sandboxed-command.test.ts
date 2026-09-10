import { renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createServer } from 'node:http';
import { executeSandboxedCommand } from '../sandboxed-command.js';

let root: string;
let cwd: string;
let secret: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-command-test-')));
  cwd = join(root, 'workspace');
  secret = join(root, 'credentials');
  await mkdir(cwd);
  await mkdir(secret);
  await writeFile(join(secret, 'auth'), 'synthetic-secret');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function run(command: string, extra = {}) {
  return executeSandboxedCommand({
    command,
    cwd,
    writableRoots: [cwd],
    deniedRoots: [secret],
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', SECRET_TOKEN: 'never-inherit' },
    signal: new AbortController().signal,
    ...extra,
  });
}

it('rejects noncanonical writable roots before executing', async () => {
  await expect(run('touch should-not-exist', { writableRoots: [cwd + '/..'] })).rejects.toThrow(
    /canonical/,
  );
});
it('rejects a cwd outside authorized workspaces', async () => {
  await expect(run('touch should-not-exist', { cwd: root })).rejects.toThrow(/workspace/);
});
it('does not execute an already cancelled request', async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(run('touch should-not-exist', { signal: abort.signal })).rejects.toThrow();
});

it('fails closed when a sandbox dependency would degrade isolation', async () => {
  vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({
    errors: [],
    warnings: ['seccomp unavailable'],
  });
  await expect(run('touch should-not-exist')).rejects.toThrow(/sandbox dependencies/);
  await expect(readFile(join(cwd, 'should-not-exist'))).rejects.toThrow();
});

// Real OS boundary tests: enable on a host that permits nested sandbox creation.
describe.runIf(process.env.MITZO_SANDBOX_INTEGRATION === '1')('OS sandbox', () => {
  it('writes inside workspace, scrubs credentials and removes its private home', async () => {
    const result = await run('printf ok > result; printf "%s|%s" "$SECRET_TOKEN" "$HOME"');
    expect(result.isError).toBe(false);
    expect(await readFile(join(cwd, 'result'), 'utf8')).toBe('ok');
    expect(result.content).toMatch(/^\|/);
    await expect(stat(result.content.slice(1))).rejects.toThrow();
  }, 20000);
  it('denies writes outside workspace and reads of credential files', async () => {
    const outside = await run(`printf bad > '${root}/outside'`);
    expect(outside.isError).toBe(true);
    await expect(readFile(join(root, 'outside'))).rejects.toThrow();
    const denied = await run(`cat '${secret}/auth'`);
    expect(denied.isError).toBe(true);
    expect(denied.content).not.toContain('synthetic-secret');
  }, 20000);
  it('denies symlink redirects into protected files', async () => {
    await symlink(secret, join(cwd, 'alias'));
    const denied = await run('cat alias/auth; printf replacement > alias/auth');
    expect(denied.isError).toBe(true);
    expect(denied.content).not.toContain('synthetic-secret');
    expect(await readFile(join(secret, 'auth'), 'utf8')).toBe('synthetic-secret');
  }, 20000);
  it('blocks direct network access even when proxy variables are ignored', async () => {
    const server = createServer((_req, res) => res.end('network-leaked'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing port');
      const denied = await run(
        `/usr/bin/curl --noproxy '*' --max-time 2 http://127.0.0.1:${address.port}`,
      );
      expect(denied.isError).toBe(true);
      expect(denied.content).not.toContain('network-leaked');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 20000);
  it('keeps loopback denied', async () => {
    const server = createServer((_req, res) => res.end('admin-leaked'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing port');
      const denied = await run(`/usr/bin/curl --max-time 2 http://localhost:${address.port}`);
      expect(denied.isError).toBe(true);
      expect(denied.content).not.toContain('admin-leaked');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 20000);
  it('denies public network access', async () => {
    const denied = await run(
      '/usr/bin/curl --fail --silent --show-error --max-time 2 https://api.github.com/rate_limit',
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).not.toContain('rate');
  }, 20000);
  it('bounds output and terminates long-running command trees', async () => {
    expect((await run('yes noisy', { maxOutputBytes: 100 })).isError).toBe(true);
    const abort = new AbortController();
    const pending = run('sleep 30; touch escaped', { signal: abort.signal });
    setTimeout(() => abort.abort(), 500);
    expect((await pending).isError).toBe(true);
    await expect(readFile(join(cwd, 'escaped'))).rejects.toThrow();
  }, 20000);
});

describe.runIf(process.env.MITZO_SANDBOX_INTEGRATION === '1')('git worktree', () => {
  it('allows worktree edits and Git inspection while blocking shared-object writes', async () => {
    const { execFileSync } = await import('node:child_process');
    const base = join(root, 'base');
    const worktree = join(root, 'git-worktree');
    await mkdir(base);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: base,
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-b', 'main');
    await writeFile(join(base, 'file'), 'base');
    git('add', 'file');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
    git('worktree', 'add', '-b', 'session/test', worktree);
    const result = await run(
      'printf change > file; git add file && git -c user.name=Test -c user.email=test@example.com commit -m change',
      {
        cwd: worktree,
        writableRoots: [worktree],
      },
    );
    expect(result.isError, result.content).toBe(true);
    expect(result.content).toContain('Shared Git objects are read-only');
    expect(await readFile(join(worktree, 'file'), 'utf8')).toBe('change');
    expect(git('log', '--format=%s', '-1', 'session/test').toString().trim()).toBe('initial');
    const inspect = await run('git status --short; git log -1 --format=%s', {
      cwd: worktree,
      writableRoots: [worktree],
    });
    expect(inspect.isError, inspect.content).toBe(false);
    expect(inspect.content).toContain('initial');
    const denied = await run(`printf bad > '${base}/file'`, {
      cwd: worktree,
      writableRoots: [worktree],
    });
    expect(denied.isError).toBe(true);
    expect(await readFile(join(base, 'file'), 'utf8')).toBe('base');
    const admin = (await readFile(join(worktree, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    const rewrite = await run(
      `printf 'ref: refs/heads/main\\n' > '${admin}/HEAD'; printf forged > .git`,
      {
        cwd: worktree,
        writableRoots: [worktree],
      },
    );
    expect(rewrite.isError).toBe(true);
    expect((await readFile(join(admin, 'HEAD'), 'utf8')).trim()).toBe(
      'ref: refs/heads/session/test',
    );
    const symbolic = await run('git symbolic-ref HEAD refs/heads/main', {
      cwd: worktree,
      writableRoots: [worktree],
    });
    expect(symbolic.isError).toBe(true);
    expect((await readFile(join(admin, 'HEAD'), 'utf8')).trim()).toBe(
      'ref: refs/heads/session/test',
    );
    const otherBranch = await run('git update-ref refs/heads/main HEAD', {
      cwd: worktree,
      writableRoots: [worktree],
    });
    expect(otherBranch.isError).toBe(true);
    expect(git('log', '--format=%s', '-1', 'main').toString().trim()).toBe('initial');
    await writeFile(join(cwd, '.git'), await readFile(join(worktree, '.git')));
    await expect(run('git add .')).rejects.toThrow(/registration/);
  }, 20000);
});

describe.runIf(process.env.MITZO_SANDBOX_INTEGRATION === '1')('regular Git checkout', () => {
  it('allows inspection but keeps in-tree Git metadata read-only', async () => {
    const { execFileSync } = await import('node:child_process');
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    execFileSync('git', ['init', checkout]);
    await writeFile(join(checkout, 'file'), 'base');
    execFileSync('git', ['-C', checkout, 'add', 'file']);
    execFileSync('git', [
      '-C',
      checkout,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'initial',
    ]);
    const inspect = await run('git status --short; git log -1 --format=%s', {
      cwd: checkout,
      writableRoots: [checkout],
    });
    expect(inspect.isError, inspect.content).toBe(false);
    expect(inspect.content).toContain('initial');
    await writeFile(join(checkout, 'file'), 'changed');
    const commit = await run(
      'git add file && git -c user.name=Test -c user.email=test@example.com commit -m changed',
      { cwd: checkout, writableRoots: [checkout] },
    );
    expect(commit.isError).toBe(true);
    expect(
      execFileSync('git', ['-C', checkout, 'log', '-1', '--format=%s'], { encoding: 'utf8' }),
    ).toContain('initial');
  }, 20000);
});

it('rechecks host authority immediately before spawn and cleans up on rejection', async () => {
  vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
  const beforeSpawn = vi.fn(() => {
    throw new Error('Mode changed');
  });
  await expect(run('touch forbidden', { beforeSpawn })).rejects.toThrow('Mode changed');
  expect(beforeSpawn).toHaveBeenCalledOnce();
  await expect(readFile(join(cwd, 'forbidden'))).rejects.toThrow();
});

describe.runIf(process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'shared Git object protection',
  () => {
    it('denies shared-object deletion, corruption, and Git object creation', async () => {
      const { execFileSync } = await import('node:child_process');
      const base = join(root, 'base');
      const worktree = join(root, 'linked');
      await mkdir(base);
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: base,
          env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
        });
      git('init', '-b', 'main');
      await writeFile(join(base, 'file'), 'original');
      git('add', 'file');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
      git('worktree', 'add', '-b', 'session/test', worktree);
      const oid = git('rev-parse', 'HEAD:file').toString().trim();
      const object = join(base, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
      const original = await readFile(object);
      const opts = { cwd: worktree, writableRoots: [worktree] };
      expect(
        (await run(`chmod u+w '${object}' && printf corruption > '${object}'`, opts)).isError,
      ).toBe(true);
      expect((await run(`rm '${object}'`, opts)).isError).toBe(true);
      expect(await readFile(object)).toEqual(original);
      const result = await run(
        'printf changed > file; git add file && git -c user.name=Test -c user.email=test@example.com commit -m change',
        opts,
      );
      expect(result.isError, result.content).toBe(true);
      expect(result.content).toContain('Shared Git objects are read-only');
      expect(git('show', 'session/test:file').toString()).toBe('original');
      const commit = await run(
        'git -c user.name=Test -c user.email=test@example.com commit --allow-empty -m denied',
        opts,
      );
      expect(commit.isError, commit.content).toBe(true);
      expect(commit.content).toContain('Shared Git objects are read-only');
      git('fsck', '--full');
    }, 30000);
  },
);

describe('sandbox authority snapshots', () => {
  beforeEach(() => {
    vi.spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] });
  });

  it('rejects a writable root replaced during asynchronous setup', async () => {
    vi.mocked(SandboxManager.checkDependencies).mockImplementationOnce(() => {
      renameSync(cwd, cwd + '-old');
      mkdirSync(cwd);
      return { errors: [], warnings: [] };
    });
    await expect(run('true')).rejects.toThrow(/Sandbox authority changed/);
  });

  it.each(['cwd', 'denied'] as const)(
    'rejects a replaced %s immediately before spawn',
    async (target) => {
      const nested = join(cwd, 'nested');
      await mkdir(nested);
      const path = target === 'cwd' ? nested : secret;
      await expect(
        run('true', {
          cwd: nested,
          beforeSpawn: () => {
            renameSync(path, path + '-old');
            mkdirSync(path);
          },
        }),
      ).rejects.toThrow(/Sandbox authority changed/);
    },
  );

  it('rejects a Git marker introduced after workspace authorization', async () => {
    await expect(
      run('true', {
        beforeSpawn: () => writeFileSync(join(cwd, '.git'), 'gitdir: /unrelated/gitdir'),
      }),
    ).rejects.toThrow(/Sandbox authority changed/);
  });

  it.each(['admin', 'marker', 'HEAD', 'commondir', 'gitdir'] as const)(
    'rejects changed Git %s authority before spawn',
    async (target) => {
      const common = join(root, 'base', '.git');
      const admin = join(common, 'worktrees', 'session');
      await mkdir(admin, { recursive: true });
      await mkdir(join(common, 'objects'));
      await writeFile(join(cwd, '.git'), `gitdir: ${admin}\n`);
      await writeFile(join(admin, 'commondir'), '../..\n');
      await writeFile(join(admin, 'gitdir'), join(cwd, '.git') + '\n');
      await writeFile(join(admin, 'HEAD'), 'ref: refs/heads/session\n');
      await expect(
        run('true', {
          beforeSpawn: () => {
            if (target === 'admin') {
              renameSync(admin, admin + '-old');
              mkdirSync(admin);
            } else
              writeFileSync(
                target === 'marker' ? join(cwd, '.git') : join(admin, target),
                'changed authority',
              );
          },
        }),
      ).rejects.toThrow(/Sandbox authority changed/);
    },
  );
});
