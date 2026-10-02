import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { knowledgeVerificationCommand, knowledgeViewManifest } from '../knowledge-view.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

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
    if (tamper === 'content') writeFileSync(note, 'draft');
    if (tamper === 'mode') chmodSync(note, 0o755);
    if (tamper === 'extra') writeFileSync(join(root, 'mgmt/injected.md'), 'extra');
    if (tamper === 'manifest') writeFileSync(join(root, 'knowledge-view.json'), '{}');
    if (tamper === 'symlink') {
      execFileSync('ln', ['-s', note, join(root, 'mgmt/injected.md')]);
    }
    expect(() => execFileSync('/bin/sh', ['-c', command], { stdio: 'pipe' })).toThrow();
  },
);
