import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStorageCommand } from '../podman-storage.mjs';
import { enrollStore } from '../lib/podman-storage-maintainer.mjs';
const id = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
describe('operator storage command', () => {
  async function fixture(action) {
    const home = await mkdtemp(join(tmpdir(), 'mitzo-cli-'));
    try {
      const selection = join(home, 'selection.json');
      await writeFile(selection, JSON.stringify({ local: true }));
      const store = {
        machineId: 'guest',
        filesystemId: 'fs',
        graphRoot: '/store',
        graphDriver: 'overlay',
        rootless: true,
        connection: 'local',
      };
      const s = {
        store,
        complete: true,
        collectedAt: Date.now(),
        images: [1, 2, 3].map((n) => ({ id: id(n), parent: '', layers: [`layer-${n}`] })),
        containers: [],
        blockers: [],
        telemetry: { guest: { status: 'available', freeBytes: 100, freeInodes: 10 } },
      };
      const removed: string[] = [];
      const deps = {
        home: join(home, 'authority'),
        collect: async () => structuredClone(s),
        remove: async (_selection, image: string) => {
          removed.push(image);
          s.images = s.images.filter((i) => i.id !== image);
          return { code: 0 };
        },
      };
      const enrollment = {
        version: 1,
        review: 'review',
        store,
        policy: { keepLatest: 2, graceDays: 7 },
        protections: Object.fromEntries(
          [
            'production',
            'staging',
            'provider',
            'supervisor',
            'candidate',
            'rollback',
            'checkpoint',
            'custodian',
          ].map((role) => [role, { complete: true, review: 'review', images: [] }]),
        ),
        producers: [{ owner: 'owner', family: 'runtime', coordinated: true, review: 'review' }],
        builds: [1, 2, 3].map((n) => ({
          operation: `legacy-${n}`,
          owner: 'owner',
          family: 'runtime',
          state: 'succeeded',
          images: [id(n)],
          completedAt: Date.now() - (20 - n) * 86400000,
          reproducible: true,
          recipeDigest: 'recipe',
          classificationReview: 'review',
        })),
      };
      await action({ home, selection, store, s, removed, deps, enrollment });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
  it('reports missing enrollment without mutating Podman', async () =>
    fixture(async ({ selection, deps, removed }) => {
      const status = await runStorageCommand(['status', '--selection', selection], deps);
      expect(status.plan.blockers.length).toBeGreaterThan(0);
      expect(removed).toEqual([]);
    }));
  it('writes an exact plan, applies only it, and persists an honest last run', async () =>
    fixture(async ({ home, selection, deps, enrollment, store, removed }) => {
      await enrollStore(deps.home, store, enrollment);
      const path = join(home, 'plan.json');
      await runStorageCommand(['plan', '--selection', selection, '--output', path], deps);
      expect(JSON.parse(await readFile(path, 'utf8')).candidates.map((i) => i.id)).toEqual([id(1)]);
      const result = await runStorageCommand(
        ['apply', '--selection', selection, '--plan', path],
        deps,
      );
      expect(result.status).toBe('complete');
      expect(removed).toEqual([id(1)]);
      expect(
        (await runStorageCommand(['status', '--selection', selection], deps)).lastRun.status,
      ).toBe('complete');
      await expect(
        runStorageCommand(['plan', '--selection', selection, '--output', path], deps),
      ).rejects.toThrow();
    }));
  it('rejects changed selected store before deletion', async () =>
    fixture(async ({ home, selection, deps, enrollment, store, s, removed }) => {
      await enrollStore(deps.home, store, enrollment);
      const path = join(home, 'plan.json');
      await runStorageCommand(['plan', '--selection', selection, '--output', path], deps);
      s.store.machineId = 'replacement';
      await expect(
        runStorageCommand(['apply', '--selection', selection, '--plan', path], deps),
      ).rejects.toThrow('store');
      expect(removed).toEqual([]);
    }));
  it('requires explicit selection and refuses unrelated commands', async () => {
    await expect(runStorageCommand(['status'])).rejects.toThrow('Usage');
    await expect(runStorageCommand(['prune', '--selection', 'x'])).rejects.toThrow('Usage');
  });
});
