import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureNativeReadAnchor,
  executeNativeAnchoredReadOperation,
} from '../native-file-operation.js';
import { discoverLocalRepository, inspectLocalRepository } from '../local-repository-discovery.js';

const unqualified = vi.hoisted(() => ({ paths: new Set<string>(), probes: [] as string[] }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      if (unqualified.paths.has(String(args[0]))) {
        unqualified.probes.push(String(args[0]));
        throw Error('Unqualified source realpath lookup');
      }
      return actual.realpath(...args);
    },
  };
});

vi.setConfig({ testTimeout: 30000 });
let root: string;
let source: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-domain-read-')));
  source = join(root, 'repository');
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    );
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline fixture');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'instructions.md'), 'Fixture instruction bytes\n');
  await symlink('instructions.md', join(source, 'AGENTS.md'));
  git('add', '.');
  git('commit', '-qm', 'fixture');
});
afterEach(async () => {
  unqualified.paths.clear();
  unqualified.probes.length = 0;
  await rm(root, { recursive: true, force: true });
});
function request(deniedRoots: readonly string[] = []) {
  const signal = AbortSignal.timeout(30000);
  const executeReadOperation = vi.fn(executeNativeAnchoredReadOperation);
  return {
    accessScope: { kind: 'roots' as const, roots: [root], deniedRoots },
    captureReadExclusions: async () => Object.freeze([...deniedRoots]),
    captureReadAnchor: (path: string) =>
      captureNativeReadAnchor({ file_path: path, deniedRoots }, signal, 5000),
    assertReadAccess: async () => {},
    executeReadOperation,
    limits: { timeoutMs: 30000 },
    signal,
  };
}
// Mechanism fixtures only: explicit direct descriptor owners/transport. Actual
// signed NativeBaseReadScope + SRT enforcement is covered in the native suite.
it('qualifies source roots and candidates without pre-anchor Node realpath probes', async () => {
  unqualified.paths.add(root);
  unqualified.paths.add(source);
  const result = await discoverLocalRepository({ ...request(), explicitPath: source });
  expect({ state: result.state, probes: unqualified.probes.length }).toEqual({
    state: 'selected',
    probes: 0,
  });
});
it('routes every directory, byte and file-alias read through the supplied original-owner transport', async () => {
  const input = request();
  const result = await inspectLocalRepository({ ...input, path: source });
  expect(
    result.instructions.files.some((file) => file.content.includes('Fixture instruction bytes')),
  ).toBe(true);
  const operations = new Set(input.executeReadOperation.mock.calls.map(([call]) => call.operation));
  expect([...operations].sort()).toEqual(['ListDirectory', 'ReadBytes', 'ReadLink']);
});
it('preserves a genuine absent-source result after qualified descriptor lookup', async () => {
  const absent = join(root, 'absent');
  unqualified.paths.add(root);
  unqualified.paths.add(absent);
  const result = await discoverLocalRepository({ ...request(), explicitPath: absent });
  expect(result).toMatchObject({
    state: 'missing',
    candidates: [],
    needed: ['source', 'destination'],
  });
  expect(unqualified.probes).toEqual([]);
});
it('refuses a directory alias before Node target lookup and never discloses the denied target', async () => {
  const denied = join(root, 'PRIVATE-DENIED-TARGET');
  const alias = join(root, 'allowed-looking-alias');
  await mkdir(denied);
  await symlink(denied, alias);
  unqualified.paths.add(alias);
  const result = await discoverLocalRepository({ ...request([denied]), explicitPath: alias });
  expect(result.state).not.toBe('selected');
  expect(result.state).not.toBe('missing');
  expect(result.candidates).toEqual([]);
  expect(unqualified.probes).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-DENIED-TARGET');
});
