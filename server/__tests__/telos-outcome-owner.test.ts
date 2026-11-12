import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { TelosSourceCapture } from '../telos-source-capture.js';
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
it('captures reviewed source with normalized links through native outcome creation and exact retry', async () => {
  const options = fixture();
  const events = new EventStore(join(dirname(options.dbPath()), 'events.db'));
  const work = new TelosWorkStore(options.dbPath(), {
    ordinaryConversation: (id) => id === 'planning',
  });
  const artifacts = new TelosArtifactStore(options.dbPath());
  try {
    events.upsertSession({ sessionId: 'planning', conversationSource: 'mitzo' });
    const sequence = events.append('planning', 'user_message', {
      messageId: 'approved',
      text: 'Keep the reviewed plan.',
    });
    const actor = { kind: 'operator' as const, id: 'offline-operator' };
    const capture = new TelosSourceCapture({
      events,
      work,
      artifacts,
      authorizeSource: () => true,
      authorizeArtifact: () => true,
    });
    const proposal = {
      requestId: randomUUID(),
      selection: {
        requestId: randomUUID(),
        expectedMembershipRevision: 0,
        sourceConversationId: 'planning',
        mode: 'selected',
        boundary: { sequence, messageId: 'approved' },
        messageIds: ['approved'],
        artifacts: [],
        purpose: 'Retain the reviewed plan',
        joiningBrief: '',
      },
      outcome: {
        summary: input.summary,
        intent: input.intent,
        rationale: input.rationale,
        acceptanceCriteria: input.acceptanceCriteria,
        profile: input.profile,
        milestones: input.milestones,
        links: [
          { type: 'external', url: ' https://example.test/plan ', title: 'Plan', description: '' },
        ],
      },
    };
    const preview = await capture.previewNew(proposal, actor);
    const reviewed = { ...proposal, previewSha256: preview.sha256 };
    const create = (body: unknown, assertCurrent: () => void) =>
      createCanonicalTelosOutcome(options, body, assertCurrent);
    const first = await capture.createReviewed(reviewed, actor, create);
    const retry = await capture.createReviewed(reviewed, actor, create);
    expect(retry).toEqual(first);
    const item = work.readSourceTarget(first.work.itemId, actor).record;
    expect(item.links).toContainEqual(
      expect.objectContaining({ url: 'https://example.test/plan' }),
    );
  } finally {
    artifacts.close();
    work.close();
    events.close();
  }
});
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
it.each([' /private/plan.md ', '   '])(
  'rejects a nonportable normalized link %j before native creation',
  async (url) => {
    const options = fixture();
    await expect(
      createCanonicalTelosOutcome(
        options,
        { ...input, links: [{ type: 'external', url, title: 'Plan', description: '' }] },
        () => {},
      ),
    ).rejects.toThrow(/portable/);
    const store = new TelosRuntimeStore(options.dbPath());
    try {
      expect(store.list().items).toEqual([]);
    } finally {
      store.close();
    }
  },
);
it('rejects asynchronous or value-returning assertions before mutation', async () => {
  const options = fixture();
  for (const assertion of [() => Promise.resolve(), () => true]) {
    await expect(
      createCanonicalTelosOutcome(options, input, assertion as () => void),
    ).rejects.toThrow('Synchronous current Telos authority required');
  }
});
