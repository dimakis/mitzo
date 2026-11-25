import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import request from 'supertest';
import { captureLocalRepository } from '../local-repository-worktree.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import type { AccountBinding, SessionRuntimeBindingV2 } from '@mitzo/protocol';

// Delay the real Git subprocess boundary, not a promise standing in for Git.
// Both implementations use the same fixture so the pre-change test measures blocking.
const probe = vi.hoisted(() => ({ script: '', repo: '', enabled: false }));
vi.mock('../read-only-git.js', () => ({ readOnlyGitExecutable: () => 'git' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const selected = (args: readonly string[]) => probe.enabled && args.includes(probe.repo);
  return {
    ...actual,
    execFileSync: vi.fn((file, args, options) =>
      selected(args)
        ? actual.execFileSync(process.execPath, [probe.script, ...args], options)
        : actual.execFileSync(file, args, options),
    ),
    execFile: vi.fn((file, args, options, callback) =>
      selected(args)
        ? actual.execFile(process.execPath, [probe.script, ...args], options, callback)
        : actual.execFile(file, args, options, callback),
    ),
  };
});

const roots: string[] = [];
const owners: RepositoryWorkspaces[] = [];
afterEach(() => {
  probe.enabled = false;
  owners.splice(0).forEach((owner) => owner.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture(delay = 1000, exitCode = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capture-responsive-')));
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline');
  git('config', 'user.email', 'offline@example.invalid');
  git('commit', '--allow-empty', '-qm', 'fixture');
  const oid = git('rev-parse', 'HEAD');
  const pidFile = join(root, 'pid');
  const calls = join(root, 'calls');
  probe.script = join(root, 'slow-git.cjs');
  writeFileSync(
    probe.script,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');
    setTimeout(() => {
      if (${exitCode}) { process.stderr.write('fixture original failure'); process.exit(${exitCode}); }
      try { process.stdout.write(require('node:child_process').execFileSync('/usr/bin/git', process.argv.slice(2), {env: process.env})); }
      catch (error) { process.stderr.write(String(error.stderr)); process.exit(error.status || 1); }
    }, ${delay});
  `,
  );
  probe.repo = repo;
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai' as const,
    model: 'offline',
    profileRevision: 'one',
  } satisfies AccountBinding;
  const runtime: SessionRuntimeBindingV2 = {
    version: 2,
    account: { accountId: 'offline', provider: 'openai', profileRevision: 'one' },
    harness: { implementation: 'responses' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'one' },
  };
  const capture = vi.fn(async () => ({
    version: 1 as const,
    originalBinding: binding,
    runtimeBinding: runtime,
    credentialDigest: 'a'.repeat(64),
  }));
  const assert = vi.fn(async () => {});
  const owner = new RepositoryWorkspaces(join(root, 'private'), {
    authorize: async () => {
      throw Error('Unexpected remote authorization');
    },
    inspect: vi.fn(),
    prepare: vi.fn(),
    localRepositories: () => ({ primary: repo }),
    ordinaryPreparation: { capture, assert },
  });
  owners.push(owner);
  const id = randomUUID();
  const select = (signal: AbortSignal) =>
    owner.selectLocalRepository(
      binding,
      'primary',
      {
        runOn: 'local',
        runtime: { account: runtime.account, harness: 'responses', targetId: 'mac' },
      },
      signal,
      id,
      'HEAD',
    );
  return { root, repo, oid, owner, id, select, capture, assert, pidFile, calls };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function started(file: string) {
  for (let n = 0; n < 200 && !existsSync(file); n++) await delay(5);
  expect(existsSync(file)).toBe(true);
}
function stopped(file: string) {
  const pid = Number(readFileSync(file, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}

it('keeps unrelated status/Stop dispatch under 250 ms during a 1 s Git source read', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = Error('Operator Stop original cause');
  probe.enabled = true;
  const start = performance.now();
  const operation = f.select(controller.signal).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  // Same event-loop dispatch used by unrelated status and Stop handlers.
  const status = await new Promise<number>((resolve) =>
    setTimeout(() => resolve(performance.now() - start), 10),
  );
  await started(f.pidFile);
  const stopStart = performance.now();
  controller.abort(reason);
  const result = await operation;
  const stopMs = performance.now() - stopStart;
  console.info(JSON.stringify({ fixtureDelayMs: 1000, statusMs: status, stopMs, budgetMs: 250 }));
  expect(status).toBeLessThan(250);
  expect(stopMs).toBeLessThan(250);
  expect(result).toEqual({ error: reason });
  stopped(f.pidFile);
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(() => f.owner.get(f.id)).toThrow();
  expect(f.assert).not.toHaveBeenCalled();
}, 15000);

it('joins the source subprocess when sibling runtime qualification fails and preserves that cause', async () => {
  const f = fixture();
  const reason = Error('Runtime custody changed');
  f.capture.mockImplementation(async () => {
    await started(f.pidFile);
    throw reason;
  });
  probe.enabled = true;
  await expect(f.select(new AbortController().signal)).rejects.toBe(reason);
  stopped(f.pidFile);
  expect(() => f.owner.get(f.id)).toThrow();
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
});

it('serves concurrent HTTP status and Stop while the real repository controller captures a source', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = Error('HTTP Stop');
  const app = express();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let selectedAt = 0;
  app.post('/select', async (_req, res) => {
    selectedAt = performance.now();
    enter();
    try {
      res.json(await f.select(controller.signal));
    } catch (error) {
      res.status(409).json({ stopped: error === reason });
    }
  });
  app.get('/status', (_req, res) => res.json({ responsive: true }));
  app.post('/stop', (_req, res) => {
    controller.abort(reason);
    res.json({ ok: true });
  });
  probe.enabled = true;
  const selecting = request(app)
    .post('/select')
    .then((response) => response);
  await entered;
  const status = await request(app).get('/status');
  const statusMs = performance.now() - selectedAt;
  await started(f.pidFile);
  const stopStart = performance.now();
  const stop = await request(app).post('/stop');
  const selected = await selecting;
  const stopMs = performance.now() - stopStart;
  console.info(
    JSON.stringify({
      adapter: 'HTTP/controller fixture',
      fixtureDelayMs: 1000,
      statusMs,
      stopMs,
      budgetMs: 250,
    }),
  );
  expect(status.body).toEqual({ responsive: true });
  expect(stop.body).toEqual({ ok: true });
  expect(statusMs).toBeLessThan(250);
  expect(stopMs).toBeLessThan(250);
  expect(selected.status).toBe(409);
  expect(selected.body).toEqual({ stopped: true });
  stopped(f.pidFile);
  expect(() => f.owner.get(f.id)).toThrow();
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
});

it('preserves the timeout reason and reaps a slow Git child before returning', async () => {
  const f = fixture(10000);
  probe.enabled = true;
  const signal = AbortSignal.timeout(100);
  const error = await captureLocalRepository('primary', f.repo, signal, 'HEAD').catch(
    (error) => error,
  );
  expect(error).toBe(signal.reason);
  expect(signal.reason.name).toBe('TimeoutError');
  stopped(f.pidFile);
}, 15000);

it('enforces the source probe 5 s deadline without relying on caller cancellation', async () => {
  const f = fixture(10000);
  probe.enabled = true;
  const start = performance.now();
  await expect(
    captureLocalRepository('primary', f.repo, new AbortController().signal, 'HEAD'),
  ).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'Local repository source read timed out',
  });
  expect(performance.now() - start).toBeLessThan(6000);
  stopped(f.pidFile);
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
}, 10000);

it('retains a nonzero Git error and does not retry the failed source command', async () => {
  const f = fixture(10, 23);
  probe.enabled = true;
  await expect(
    captureLocalRepository('primary', f.repo, new AbortController().signal, 'HEAD'),
  ).rejects.toMatchObject({ code: 23, stderr: 'fixture original failure' });
  stopped(f.pidFile);
  expect(readFileSync(f.calls, 'utf8').trim().split('\n')).toHaveLength(1);
});

it('preserves explicit HEAD capture and rejects an already cancelled request before spawning', async () => {
  const f = fixture(0);
  probe.enabled = true;
  await expect(
    captureLocalRepository('primary', f.repo, new AbortController().signal, 'HEAD'),
  ).resolves.toMatchObject({ baseOid: f.oid, baseBranch: 'main', localSource: { path: f.repo } });
  const count = readFileSync(f.calls, 'utf8');
  const reason = Error('Already stopped');
  await expect(
    captureLocalRepository('primary', f.repo, AbortSignal.abort(reason), 'HEAD'),
  ).rejects.toBe(reason);
  expect(readFileSync(f.calls, 'utf8')).toBe(count);
});
