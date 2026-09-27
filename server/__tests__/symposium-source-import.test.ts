import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSourceArtifact } from '../symposium-source-import.js';
it('journals exact helper identity and output before later auth/custody checks, never retries ambiguous start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-helper-'));
  const events: string[] = [];
  const bundle = Buffer.from('bundle');
  const manifest = {
    repositoryId: 'repo',
    targetRepository: 'owner/repo',
    baseBranch: 'main',
    featureBranch: 'change',
    baseOid: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
    sourceIdentity: 'c'.repeat(64),
    historyCommits: 1,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    bundleBytes: bundle.length,
  };
  const receipt = {
    intent: () => events.push('intent'),
    created: () => events.push('created'),
    removed: () => events.push('removed'),
  };
  const command = vi.fn(async (args: readonly string[]) => {
    events.push(args[0]);
    if (args[0] === 'create') return 'd'.repeat(64);
    if (args[0] === 'start') throw Error('timeout');
    return '';
  });
  try {
    await expect(
      importSourceArtifact({
        name: 'mitzo-artifacts-test',
        owner: { image: 'pinned', uid: 998, gid: 998 },
        stagingParent: root,
        bundle,
        manifest,
        command,
        custody: () => {},
        authorize: () => {},
        receipt,
        observed: () => events.push('observed'),
      }),
    ).rejects.toThrow('timeout');
    expect(events).toEqual(['intent', 'create', 'created', 'start']);
    expect(command).toHaveBeenCalledTimes(2);
    expect(readdirSync(root)).toHaveLength(1);
    events.length = 0;
    command.mockImplementation(async (args) => {
      events.push(args[0]);
      return args[0] === 'create'
        ? 'e'.repeat(64)
        : args[0] === 'start'
          ? JSON.stringify({
              commit: manifest.baseOid,
              tree: manifest.treeOid,
              featureBranch: manifest.featureBranch,
              bundleSha256: manifest.bundleSha256,
              files: 1,
              bytes: 3,
            })
          : '';
    });
    await importSourceArtifact({
      name: 'mitzo-artifacts-other',
      owner: { image: 'pinned', uid: 998, gid: 998 },
      stagingParent: root,
      bundle,
      manifest,
      command,
      custody: () => {},
      authorize: () => {},
      receipt,
      observed: () => events.push('observed'),
    });
    expect(events).toEqual(['intent', 'create', 'created', 'start', 'observed', 'rm', 'removed']);
    const args = command.mock.calls.find(([args]) => args[0] === 'create')![0];
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
