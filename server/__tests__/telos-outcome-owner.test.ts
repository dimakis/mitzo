import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { createCanonicalTelosOutcome } from '../telos-outcome-owner.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const input = {
  summary: 'Outcome',
  intent: 'Result',
  rationale: 'Why',
  acceptanceCriteria: ['Evidence'],
  profile: 'manual',
  milestones: ['Slice'],
  idempotencyKey: 'reviewed-original',
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-native-creator-'));
  roots.push(root);
  const path = join(root, 'telos.db');
  TelosRuntimeStore.initialize(path);
  return { dbPath: () => path };
}
it('creates in the selected canonical database and recovers the same IDs without an external owner', async () => {
  const options = fixture();
  const first = await createCanonicalTelosOutcome(options, input, () => {});
  const second = await createCanonicalTelosOutcome(options, input, () => {});
  expect(first.receipt).toMatchObject({
    ok: true,
    created: true,
    item: { summary: 'Outcome', children: [{ summary: 'Slice' }] },
  });
  expect(second).toMatchObject({
    itemId: first.itemId,
    receipt: { created: false, item: { id: first.itemId } },
  });
});
it('renews current authority inside the canonical transaction before any creation', async () => {
  const options = fixture();
  await expect(
    createCanonicalTelosOutcome(options, input, () => {
      throw Error('revoked');
    }),
  ).rejects.toThrow('revoked');
  const store = new TelosRuntimeStore(options.dbPath());
  try {
    expect(store.list().items).toEqual([]);
  } finally {
    store.close();
  }
});
it('rejects asynchronous or value-returning assertions before mutation', async () => {
  const options = fixture();
  for (const assertion of [() => Promise.resolve(), () => true]) {
    await expect(
      createCanonicalTelosOutcome(options, input, assertion as () => void),
    ).rejects.toThrow('Synchronous current Telos authority required');
  }
});
