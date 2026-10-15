import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  realpathSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  knowledgeVerificationCommand,
  knowledgePresenceCommand,
  knowledgeViewManifest,
  knowledgeCleanupCommand,
  knowledgeCacheStatusCommand,
  knowledgeCacheRepairCommand,
  knowledgeCacheProbeCommand,
  knowledgeDeliveryCommand,
} from '../knowledge-view.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

it('distinguishes absent and damaged caches in one probe, including dangling symlinks', () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-probe-')));
  const cache = join(root, 'cache');
  const probe = () =>
    JSON.parse(
      execFileSync('/bin/sh', ['-c', knowledgeCacheProbeCommand(cache, sha('manifest'))], {
        encoding: 'utf8',
      }),
    );
  expect(probe()).toEqual({ valid: false, present: false });
  execFileSync('ln', ['-s', join(root, 'missing'), cache]);
  expect(probe()).toEqual({ valid: false, present: true });
});

it.each(['valid', 'content', 'mode', 'manifest', 'compiler'])(
  'batches delivery and stops dependent work for state=%s',
  (state) => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-delivery-')));
    const cache = join(root, "quoted' parent", `knowledge-${sha('active')}`);
    mkdirSync(join(cache, 'mgmt'), { recursive: true });
    const note = join(cache, 'mgmt/note.md');
    writeFileSync(note, 'accepted');
    chmodSync(note, 0o644);
    const view = knowledgeViewManifest({
      startingCommit: 'a'.repeat(40),
      payloadSha256: 'b'.repeat(64),
      files: { 'note.md': { sha256: sha('accepted'), mode: '0644' } },
    });
    const bytes = JSON.stringify(view);
    writeFileSync(join(cache, 'knowledge-view.json'), bytes);
    const expired = Array.from({ length: 12 }, (_, i) =>
      join(dirname(cache), `knowledge-${sha(String(i))}`),
    );
    const old = new Date(Date.now() - 40 * 86400 * 1000);
    for (const version of expired) {
      mkdirSync(version);
      utimesSync(version, old, old);
    }
    const context = { fullMarkdown: 'compiled context' };
    const marker = join(root, 'compiled');
    const compiler = join(root, 'compiler.cjs');
    writeFileSync(
      compiler,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv[2]); ${state === 'compiler' ? 'process.exit(1)' : `console.log(${JSON.stringify(JSON.stringify(context))})`}`,
    );
    if (state === 'content') writeFileSync(note, 'damaged');
    if (state === 'mode') chmodSync(note, 0o755);
    if (state === 'manifest') writeFileSync(join(cache, 'knowledge-view.json'), '{}');
    const command = knowledgeDeliveryCommand(cache, sha(bytes), true)
      .replace('/usr/bin/node', process.execPath)
      .replace('/sandbox/compile-mgmt-context.mjs', compiler);
    if (state === 'valid') {
      expect(JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }))).toEqual({
        receipt: { sourceCommit: view.sourceCommit, payloadSha256: view.payloadSha256 },
        context,
      });
      expect(readFileSync(marker, 'utf8')).toBe(join(cache, 'mgmt'));
      expect(expired.filter(existsSync)).toHaveLength(9);
      expect(
        JSON.parse(
          execFileSync('/bin/sh', ['-c', knowledgeCacheProbeCommand(cache, sha(bytes))], {
            encoding: 'utf8',
          }),
        ),
      ).toEqual({ valid: true, present: true });
      const withoutCompile = knowledgeDeliveryCommand(cache, sha(bytes), false);
      rmSync(marker);
      expect(
        JSON.parse(execFileSync('/bin/sh', ['-c', withoutCompile], { encoding: 'utf8' })),
      ).toEqual({
        receipt: { sourceCommit: view.sourceCommit, payloadSha256: view.payloadSha256 },
      });
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(() => execFileSync('/bin/sh', ['-c', command], { stdio: 'pipe' })).toThrow();
      expect(existsSync(marker)).toBe(state === 'compiler');
      expect(expired.every(existsSync)).toBe(true);
    }
  },
);

it('reclaims only expired unreferenced content-addressed sandbox views', () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-retention-')));
  const versions = Array.from({ length: 14 }, (_, i) => join(root, `knowledge-${sha(String(i))}`));
  const old = new Date(Date.now() - 40 * 86400 * 1000);
  for (const [i, path] of versions.entries()) {
    mkdirSync(join(path, 'mgmt'), { recursive: true });
    utimesSync(path, i < 10 ? new Date() : old, i < 10 ? new Date() : old);
  }
  writeFileSync(join(versions[11], '.pinned'), 'manual pin');
  mkdirSync(join(root, 'publication-legacy'));
  execFileSync('/bin/sh', ['-c', knowledgeCleanupCommand(join(versions[10], 'mgmt'))]);
  expect(versions.slice(0, 12).every(existsSync)).toBe(true);
  expect(versions.slice(12).some(existsSync)).toBe(false);
  expect(existsSync(join(root, 'publication-legacy'))).toBe(true);
});

it('attests the exact knowledge lane while excluding portable Git administration', () => {
  const view = knowledgeViewManifest({
    startingCommit: 'a'.repeat(40),
    payloadSha256: 'b'.repeat(64),
    files: {
      'memory/note.md': { sha256: sha('accepted'), mode: '0644' },
      '.git/HEAD': { sha256: sha('main'), mode: '0644' },
    },
  });
  expect(view.files).toEqual({ 'memory/note.md': { sha256: sha('accepted'), mode: '0644' } });
  expect(view.sourceCommit).toBe('a'.repeat(40));
});

it.each(['content', 'mode', 'extra', 'symlink', 'manifest'])(
  'remote verification rejects %s tampering before context compilation',
  (tamper) => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-verifier-')));
    mkdirSync(join(root, 'mgmt/memory'), { recursive: true });
    const note = join(root, 'mgmt/memory/note.md');
    writeFileSync(note, 'accepted');
    chmodSync(note, 0o644);
    const view = knowledgeViewManifest({
      startingCommit: 'a'.repeat(40),
      payloadSha256: 'b'.repeat(64),
      files: { 'memory/note.md': { sha256: sha('accepted'), mode: '0644' } },
    });
    const bytes = JSON.stringify(view);
    writeFileSync(join(root, 'knowledge-view.json'), bytes);
    const command = knowledgeVerificationCommand(root, sha(bytes));
    expect(() => execFileSync('/bin/sh', ['-c', command])).not.toThrow();
    expect(
      execFileSync('/bin/sh', ['-c', knowledgeCacheStatusCommand(root, sha(bytes))], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('true');
    if (tamper === 'content') writeFileSync(note, 'draft');
    if (tamper === 'mode') chmodSync(note, 0o755);
    if (tamper === 'extra') writeFileSync(join(root, 'mgmt/injected.md'), 'extra');
    if (tamper === 'manifest') writeFileSync(join(root, 'knowledge-view.json'), '{}');
    if (tamper === 'symlink') {
      execFileSync('ln', ['-s', note, join(root, 'mgmt/injected.md')]);
    }
    expect(() => execFileSync('/bin/sh', ['-c', command], { stdio: 'pipe' })).toThrow();
    expect(
      execFileSync('/bin/sh', ['-c', knowledgeCacheStatusCommand(root, sha(bytes))], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('false');
  },
);

it.each([
  '/sandbox/workspaces/mgmt',
  '/tmp/knowledge-' + 'a'.repeat(64),
  '/sandbox/workspaces/knowledge/../mgmt',
])('never repairs a task or unrelated path: %s', (path) => {
  expect(() => knowledgeCacheRepairCommand(path)).toThrow();
});

it.each(['file', 'directory', 'symlink', 'dangling-symlink'])(
  'repairs only the selected invalid %s cache entry',
  (kind) => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'knowledge-repair-')));
    const cache = join(root, 'knowledge-' + sha('selected'));
    const task = join(root, 'task-data');
    writeFileSync(task, 'preserve');
    if (kind === 'file') writeFileSync(cache, 'invalid');
    if (kind === 'directory') mkdirSync(cache);
    if (kind === 'symlink') execFileSync('ln', ['-s', task, cache]);
    if (kind === 'dangling-symlink') execFileSync('ln', ['-s', join(root, 'absent-target'), cache]);
    expect(
      execFileSync('/bin/sh', ['-c', knowledgePresenceCommand(cache)], { encoding: 'utf8' }).trim(),
    ).toBe('true');
    // Relocate the fixed sandbox prefix into this disposable local fixture.
    const command = knowledgeCacheRepairCommand(
      '/sandbox/workspaces/knowledge/knowledge-' + sha('selected'),
    ).replaceAll('/sandbox/workspaces/knowledge', root);
    execFileSync('/bin/sh', ['-c', command], { stdio: 'pipe' });
    expect(existsSync(cache)).toBe(false);
    expect(readFileSync(task, 'utf8')).toBe('preserve');
  },
);
