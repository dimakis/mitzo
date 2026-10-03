import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  migrationCapacity,
  requireRuntimeMigrationCapacity,
} from '../openshell-runtime-migration-capacity.js';
it('admits an exact small payload despite a nearly full VM and preserves original allocation', () => {
  const proof = migrationCapacity(10 * 1024 * 1024, 5 * 1024 * 1024, 2.3e9, 2.3e9);
  expect(proof.vmRequiredBytes).toBe(104 * 1024 * 1024);
});
it.each(['host', 'vm'] as const)(
  'blocks insufficient %s capacity with exact byte requirements',
  (side) => {
    expect(() =>
      migrationCapacity(1024, 512, side === 'host' ? 1 : 1e9, side === 'vm' ? 1 : 1e9),
    ).toThrow(/requires.*bytes, available/);
  },
);
it('rejects ambiguous or invalid capacity estimates', () => {
  expect(() => migrationCapacity(NaN, 0, 1e9, 1e9)).toThrow('invalid');
});

it('accounts for many small files in extraction capacity rather than only tar bytes', () => {
  const proof = migrationCapacity(1024, 0, 1e9, 1e9, 1000);
  expect(proof.vmRequiredBytes).toBe(3 * (1024 + 1000 * 4096) + 64 * 1024 * 1024);
});

it.each(['valid', 'wrong-host', 'uncached', 'ambiguous-vm'] as const)(
  'verifies actual backend capacity provenance: %s',
  async (caseName) => {
    const root = mkdtempSync(join(tmpdir(), 'migration-capacity-'));
    try {
      const seed = join(root, 'seed');
      mkdirSync(seed);
      writeFileSync(join(seed, 'file'), 'safe');
      const archive = join(root, 'archive.tar');
      execFileSync('tar', ['-cf', archive, '-C', seed, '.']);
      const calls: string[][] = [];
      const run = async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'image')
          return JSON.stringify([{ Digest: caseName === 'uncached' ? 'wrong' : 'target' }]);
        if (args[0] === 'info')
          return JSON.stringify({
            store: { graphRoot: '/var/lib/containers/storage' },
            host: { hostname: 'backend' },
          });
        if (args[1] === 'list')
          return JSON.stringify(
            caseName === 'ambiguous-vm' ? [] : [{ Name: 'trusted-vm', Running: true }],
          );
        if (args[3] === 'hostname') return caseName === 'wrong-host' ? 'different' : 'backend';
        if (args[3] === 'stat') return '4096';
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 10000000 1000000 9000000 10% /var\n';
      };
      const operation = requireRuntimeMigrationCapacity(
        {
          checkpointPath: archive,
          privateDirectory: root,
          seedDirectory: seed,
          targetImage: 'target',
          imageReference: 'cached-tag',
        },
        run,
      );
      if (caseName === 'valid') {
        const proof = await operation;
        expect(proof.archiveEntries).toBe(2);
        expect(proof.seedBytes).toBe(8192);
        expect(proof.vmFreeBytes).toBe(9000000 * 1024);
        expect(calls[0]).toEqual(['image', 'inspect', 'cached-tag']);
      } else await expect(operation).rejects.toThrow(/capacity|cached/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
