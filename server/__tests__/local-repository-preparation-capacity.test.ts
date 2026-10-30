import { afterAll, afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { fixtureQualifiedLocalPreparationSource } from './fixtures/qualified-local-preparation-source.js';

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ['adopted', 'claimed', true, true],
  ['unfinished', 'ready', false, false],
  ['unadopted', 'claimed', false, false],
] as const)(
  'bounds unfinished preparations independently of eight %s tasks',
  async (_label, state, allowed, adopted) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network or model calls');
      }),
    );
    const f = await localPreparationNativeFixture(cleanups, async (context, input) => {
      const held = await captureLocalRepositoryPreparationAuthorization(
        {
          context,
          events: f.f.events,
          registry: f.registry,
          workspaces: f.f.workspace,
          qualifySource: async (_path, _original, intent) =>
            fixtureQualifiedLocalPreparationSource(
              { ...intent, layout: 'standalone' as const },
              { assertCurrentSync() {}, async assertCurrent() {} },
            ),
        },
        input,
      );
      return { preparationId: held.request.id };
    });
    const db = new Database(join(f.f.root, 'repositories', 'workspaces.db'));
    cleanups.push(() => db.close());
    // Controlled retained capacity DATA, not authority for any filesystem effect.
    const seed = Array.from({ length: 8 }, () => {
      const id = randomUUID();
      const record = JSON.stringify({
        id,
        state,
        binding: f.a.initial.lease.binding,
        ...(adopted ? { preparedRepositoryTransitionAdoption: { version: 1 } } : {}),
        qualifiedLocalPreparation: { allocationFacts: { layout: 'standalone' } },
      });
      db.prepare(
        'INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,NULL)',
      ).run(id, record);
      return { id, record };
    });
    const result = await f.a.call({
      path: join(f.f.root, 'source'),
      base: { kind: 'ref', ref: 'HEAD' },
    });
    if (allowed) expect(result.response.success, JSON.stringify(result.value)).toBe(true);
    else {
      const failure = JSON.parse(result.value);
      expect(result.response.success).toBe(false);
      expect(failure).toMatchObject({
        error: 'resource_exhausted',
        diagnostic: {
          stage: 'repository_preparation',
          reason: 'preparation_capacity',
          effectStatus: 'not_started',
        },
      });
      expect(failure.action).toMatch(/unfinished|retire/i);
    }
    for (const row of seed)
      expect(db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(row.id)).toEqual(
        { record: row.record },
      );
    expect(f.permissions).toEqual([]);
  },
  60000,
);
