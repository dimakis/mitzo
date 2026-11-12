import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPortableSupplementalBoundary,
  selectSupplementalExecution,
} from './portable-supplemental-boundary.mjs';
import { initialize, load } from './restart-child-loader.mjs';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 's9-portable-cli-')));
  roots.push(root);
  mkdirSync(join(root, 'command_center'));
  const script = join(root, 'command_center', 'todo_api.py');
  const db = join(root, 'canonical.db');
  writeFileSync(script, '# Private canonical CLI fixture\n');
  writeFileSync(db, 'private database');
  const env = {
    NODE_ENV: 'test',
    S9_SUPPLEMENTAL_PORTABLE_CLI: '1',
    REPO_PATH: root,
    TELOS_DB_PATH: db,
    PATH: '/fixture-python/bin:/usr/bin:/bin',
  };
  const child = { fixture: true };
  const spawn = vi.fn(() => child);
  return { root, script, db, env, child, spawn };
}

it('requires an explicit portable qualification mode on Linux and retains the real Mac default', () => {
  expect(selectSupplementalExecution('darwin', undefined)).toBe('native-macos');
  expect(selectSupplementalExecution('linux', '1')).toBe('portable-fixture-cli');
  expect(selectSupplementalExecution('darwin', '1')).toBe('portable-fixture-cli');
  for (const [platform, mode] of [
    ['linux', undefined],
    ['win32', '1'],
    ['darwin', 'yes'],
  ])
    expect(() => selectSupplementalExecution(platform, mode)).toThrow();
});

it('uses the original protected-command runner interface for only the selected real fixture CLI', () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const boundary = createPortableSupplementalBoundary({ env: f.env, spawn: f.spawn });
  expect(boundary.credentialIsolation).toBe(false);
  const options = {
    command: 'python3',
    args: [f.script, '--list'],
    cwd: f.root,
    env: f.env,
    signal,
  };
  expect(boundary.spawnClaudeCodeProcess(options)).toBe(f.child);
  expect(f.spawn).toHaveBeenCalledWith('python3', options.args, {
    cwd: f.root,
    env: f.env,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
});

it.each(['disabled', 'non-test', 'wrong-script', 'foreign-db', 'wrong-command', 'cancelled'])(
  'rejects %s before starting a portable fixture process',
  (change) => {
    const f = fixture();
    const controller = new AbortController();
    const env = { ...f.env };
    if (change === 'disabled') env.S9_SUPPLEMENTAL_PORTABLE_CLI = '';
    if (change === 'non-test') env.NODE_ENV = 'production';
    const options = {
      command: change === 'wrong-command' ? 'sh' : 'python3',
      args: [change === 'wrong-script' ? join(f.root, 'other.py') : f.script, '--list'],
      cwd: f.root,
      env: { ...env, ...(change === 'foreign-db' ? { TELOS_DB_PATH: '/foreign.db' } : {}) },
      signal: controller.signal,
    };
    if (change === 'cancelled') controller.abort();
    expect(() =>
      createPortableSupplementalBoundary({ env, spawn: f.spawn }).spawnClaudeCodeProcess(options),
    ).toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
  },
);

it('routes only explicit portable restart children to the shared test boundary', async () => {
  const root = '/fixture/source';
  const url = pathToFileURL(join(root, 'server/credential-sdk-boundary.ts')).href;
  const next = vi.fn(async () => ({ untouched: true }));
  initialize({ root, portableSupplemental: false });
  await expect(load(url, {}, next)).resolves.toEqual({ untouched: true });
  initialize({ root, portableSupplemental: true });
  const selected = await load(url, {}, next);
  expect(selected).toMatchObject({ format: 'module', shortCircuit: true });
  expect(selected.source).toContain('portable-supplemental-boundary.mjs');
  expect(selected.source).toContain('runtimeFilesystemSdkBoundary');
  expect(selected.source).toContain('?s9-portable-original');
  await expect(load(url + '?s9-portable-original', {}, next)).resolves.toEqual({ untouched: true });
});
