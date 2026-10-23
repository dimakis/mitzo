import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLocalRepository as inspectRepository } from '../local-repository-discovery.js';

// Emulate Git builds/filesystems with coarse stat precision. The real Git process
// still reads and hashes the fixture; no status output or index bytes are mocked.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const custom = Symbol.for('nodejs.util.promisify.custom');
  return {
    ...actual,
    execFile: new Proxy(actual.execFile.bind(actual), {
      get(target, key, receiver) {
        const value = Reflect.get(actual.execFile, key, receiver);
        if (key !== custom) return value;
        return (...args: unknown[]) => {
          if (Array.isArray(args[1]) && args[1].includes('status')) {
            args[1] = ['-c', 'core.checkStat=minimal', '-c', 'core.trustctime=false', ...args[1]];
          }
          return Reflect.apply(value, target, args);
        };
      },
    }),
  };
});

import {
  fixtureReadAnchor,
  fixtureReadExclusions,
} from './fixtures/local-repository-read-owner.js';
const inspectLocalRepository = (request: Parameters<typeof inspectRepository>[0]) =>
  inspectRepository({
    captureReadAnchor: fixtureReadAnchor,
    captureReadExclusions: fixtureReadExclusions,
    ...request,
  });

// Descriptor-relative fixture I/O launches the isolated existing Python helper.
vi.setConfig({ testTimeout: 30000 });

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it('detects same-size same-stat edits without changing source index or running filters', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-racy-status-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root!, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline Fixture');
  git('config', 'user.email', 'offline@example.invalid');
  const source = join(root, 'source.txt');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  await writeFile(source, 'original\n');
  await utimes(source, timestamp, timestamp);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  await writeFile(join(root, 'staged.txt'), 'staged work\n');
  git('add', 'staged.txt');
  const indexBefore = await readFile(join(root, '.git', 'index'));
  const marker = join(root, 'filter-executed');
  git('config', 'filter.danger.clean', `touch '${marker}'; cat`);
  await writeFile(join(root, '.gitattributes'), 'source.txt filter=danger\n');
  await writeFile(source, 'modified\n');
  await utimes(source, timestamp, timestamp);
  const result = await inspectLocalRepository({
    path: root,
    accessScope: { kind: 'roots', roots: [root] },
  });
  expect(result.dirty).toMatchObject({
    state: 'dirty',
    entries: expect.arrayContaining([
      expect.objectContaining({ path: 'source.txt', worktree: 'M' }),
      expect.objectContaining({ path: 'staged.txt', index: 'A' }),
    ]),
  });
  expect(await readFile(join(root, '.git', 'index'))).toEqual(indexBefore);
  expect(await readFile(source, 'utf8')).toBe('modified\n');
  expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull();
});
