import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';
import { TelosWorkAdvisorDraft } from '../telos-work-advisor-draft.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { TelosSourceCapture } from '../telos-source-capture.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import type { TelosWorkAdvisorDraftPreviewRequest } from '@mitzo/protocol';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function fixture(purpose: 'child' | 'refine' = 'child') {
  const f = createTelosSourceApprovalData();
  cleanups.push(() => f.close());
  const db = new Database(f.dbPath);
  db.exec("ALTER TABLE items ADD COLUMN categories TEXT DEFAULT '[]'");
  db.close();
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  };
  f.events.upsertSession({ sessionId: 'planning', accountBinding: binding });
  f.work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: 'parent-kind',
      expectedRevision: f.work.read('studio', f.actor).revision,
      kind: 'outcome',
    },
    f.actor,
  );
  const context = reviewTelosWorkRoleContext({
    work: f.work,
    artifacts: f.artifacts,
    actor: f.actor,
    itemId: 'studio',
    role: 'advisor',
    advisorPurpose: purpose,
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  retainTelosWorkRoleContext(f.events, 'planning', binding, context);
  f.work.execute(
    {
      operation: 'link',
      itemId: 'studio',
      requestId: 'bound-advisor',
      expectedRevision: f.work.read('studio', f.actor).revision,
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    },
    f.actor,
  );
  const sequence = f.events.append('planning', 'user_message', {
    messageId: 'draft-choice',
    text: 'Save this acoustic treatment draft; implementation remains a separate decision.',
  });
  const assertAuthorized = vi.fn(() => {});
  const deps = () => ({
    events: f.events,
    artifacts: f.artifacts,
    work: f.work,
    assertAuthorized,
    authorizeSource: () => true,
    authorizeArtifact: () => true,
  });
  const revision = f.work.read('studio', f.actor).revision;
  const input: TelosWorkAdvisorDraftPreviewRequest = {
    requestId: randomUUID(),
    operation: purpose,
    itemId: 'studio',
    advisorConversationId: 'planning',
    expectedRevision: revision,
    parentId: purpose === 'child' ? 'studio' : null,
    expectedParentRevision: purpose === 'child' ? revision : null,
    proposed: {
      name: 'Acoustic treatment',
      desiredOutcome: 'Record with the reviewed acoustic treatment',
      type: purpose === 'refine' ? 'outcome' : 'work_item',
      category: 'Music',
    },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning',
      mode: 'selected' as const,
      boundary: { sequence, messageId: 'draft-choice' },
      messageIds: ['draft-choice'],
      artifacts: [],
      purpose: 'Save the reviewed planning draft',
      joiningBrief: '',
    },
  };
  return {
    f,
    input,
    assertAuthorized,
    owner: () => new TelosWorkAdvisorDraft(deps()),
    capture: () => new TelosSourceCapture(deps()),
  };
}
it('atomically saves a reviewed child draft with proposed brief and exact planning provenance while leaving all execution unallocated', async () => {
  const r = fixture();
  const parent = r.f.work.read('studio', r.f.actor);
  const preview = await r.owner().preview(r.input, r.f.actor);
  expect(JSON.parse(preview.packet.brief.text)).toMatchObject({
    parentId: 'studio',
    expectedParentRevision: parent.revision,
    proposed: r.input.proposed,
  });
  expect(preview.packet.context.boundary).toEqual(r.input.selection.boundary);
  expect(preview.packet.context.messages.map((message) => message.messageId)).toEqual([
    'draft-choice',
  ]);
  const save = { ...r.input, previewSha256: preview.sha256 };
  const receipt = await r.owner().save(save, r.f.actor);
  expect(receipt.work.itemId).not.toBe('studio');
  expect(receipt.work.parentId).toBe('studio');
  expect(receipt.work.kind).toBe('work_item');
  expect(receipt.work.assignments).toEqual([]);
  expect(receipt.work.attempts).toEqual([]);
  expect(receipt.work.links).toContainEqual(
    expect.objectContaining({
      role: 'origin',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    }),
  );
  const record = r.f.work.readRecord(receipt.work.itemId, r.f.actor);
  expect(record).toMatchObject({
    summary: r.input.proposed.name,
    intent: r.input.proposed.desiredOutcome,
    categories: ['Music'],
  });
  const retained = r
    .capture()
    .read(receipt.work.itemId, receipt.work.sources[0].snapshotId, r.f.actor);
  expect(retained.packet).toEqual(preview.packet);
  expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
  expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
  r.f.restartOwners();
  expect(await r.owner().save(save, r.f.actor)).toEqual(receipt);
});

it('refines only the reviewed fields and preserves criteria and advisor context without allocating work', async () => {
  const r = fixture('refine');
  const original = r.f.work.readRecord('studio', r.f.actor);
  const links = r.f.work.read('studio', r.f.actor).links;
  const preview = await r.owner().preview(r.input, r.f.actor);
  const input = { ...r.input, previewSha256: preview.sha256 };
  const saved = await r.owner().save(input, r.f.actor);
  const record = r.f.work.readRecord('studio', r.f.actor);
  expect(record).toMatchObject({
    summary: r.input.proposed.name,
    intent: r.input.proposed.desiredOutcome,
    categories: [r.input.proposed.category],
    rationale: original.rationale,
    acceptanceCriteria: original.acceptanceCriteria,
    profile: original.profile,
    parentId: original.parentId,
  });
  expect(saved.work.links).toEqual(expect.arrayContaining(links));
  expect(saved.work.assignments).toEqual([]);
  expect(saved.work.attempts).toEqual([]);
  const db = new Database(r.f.dbPath);
  db.prepare("UPDATE items SET intent='A later reviewed revision' WHERE id='studio'").run();
  db.close();
  r.f.restartOwners();
  expect(await r.owner().save(input, r.f.actor)).toEqual(saved);
  expect(r.f.work.readRecord('studio', r.f.actor).intent).toBe('A later reviewed revision');
  expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
});

it('rolls child row source bytes backlinks and receipt back together when artifact retention is interrupted', async () => {
  const r = fixture();
  const preview = await r.owner().preview(r.input, r.f.actor);
  const input = { ...r.input, previewSha256: preview.sha256 };
  const counts = () => {
    const db = new Database(r.f.dbPath);
    try {
      return [
        'items',
        'telos_artifact_revisions',
        'telos_work_links',
        'telos_work_sources',
        'telos_work_commands',
      ].map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
    } finally {
      db.close();
    }
  };
  const before = counts();
  const borrow = TelosArtifactStore.borrowConnection.bind(TelosArtifactStore);
  vi.spyOn(TelosArtifactStore, 'borrowConnection').mockImplementationOnce((database) => {
    const artifacts = borrow(database);
    const save = artifacts.save.bind(artifacts);
    vi.spyOn(artifacts, 'save').mockImplementationOnce((packet) => {
      save(packet);
      throw new Error('source retention interrupted');
    });
    return artifacts;
  });
  await expect(r.owner().save(input, r.f.actor)).rejects.toThrow('source retention interrupted');
  expect(counts()).toEqual(before);
  expect(r.f.work.advisorDraftReceipt(input, r.f.actor)).toBeUndefined();
  expect((await r.owner().save(input, r.f.actor)).work.sources).toHaveLength(1);
});

it('rechecks operator and bound advisor purpose after source compilation and refuses private or unrelated saves', async () => {
  const r = fixture();
  const compile = TelosSourceCapture.prototype.previewAdvisorDraft;
  vi.spyOn(TelosSourceCapture.prototype, 'previewAdvisorDraft').mockImplementationOnce(
    async function (this: TelosSourceCapture, input, actor) {
      const preview = await compile.call(this, input, actor);
      r.assertAuthorized.mockImplementation(() => {
        throw new Error('operator revoked during source compilation');
      });
      return preview;
    },
  );
  const parent = r.f.work.read('studio', r.f.actor);
  await expect(r.owner().preview(r.input, r.f.actor)).rejects.toThrow('operator revoked');
  expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
  r.assertAuthorized.mockImplementation(() => {});
  await expect(
    r.owner().preview(r.input, { kind: 'conversation', id: 'planning' }),
  ).rejects.toThrow('Interactive operator authority');
  await expect(
    r
      .owner()
      .preview(
        { ...r.input, operation: 'refine', parentId: null, expectedParentRevision: null },
        r.f.actor,
      ),
  ).rejects.toThrow('Exact bound advisor draft scope');
  const db = new Database(r.f.dbPath);
  db.prepare("UPDATE items SET profile='lifeops' WHERE id='studio'").run();
  db.close();
  await expect(r.owner().preview(r.input, r.f.actor)).rejects.toThrow('private case storage');
});

it.each([
  { category: 'Planning', expected: ['Planning', 'Mitzo'] },
  { category: 'Mitzo', expected: ['Mitzo'] },
])(
  'replaces only the primary category and preserves secondary categories for $category',
  async ({ category, expected }) => {
    const r = fixture('refine');
    const db = new Database(r.f.dbPath);
    db.prepare('UPDATE items SET categories=\'["Job","Mitzo"]\' WHERE id=\'studio\'').run();
    db.close();
    r.input.expectedRevision = r.f.work.read('studio', r.f.actor).revision;
    r.input.proposed.category = category;
    const preview = await r.owner().preview(r.input, r.f.actor);
    await r.owner().save({ ...r.input, previewSha256: preview.sha256 }, r.f.actor);
    expect(r.f.work.readRecord('studio', r.f.actor).categories).toEqual(expected);
  },
);

it('refuses a hidden item type change during refinement in both source preview and the atomic work owner', async () => {
  const r = fixture('refine');
  const before = r.f.work.read('studio', r.f.actor);
  const proposed = { ...r.input.proposed, type: 'work_item' as const };
  await expect(r.owner().preview({ ...r.input, proposed }, r.f.actor)).rejects.toThrow(
    'Refinement cannot change item type',
  );
  const preview = await r.owner().preview(r.input, r.f.actor);
  expect(() =>
    r.f.work.saveAdvisorDraft(
      { ...r.input, proposed, previewSha256: preview.sha256 },
      r.f.actor,
      () => {
        throw new Error('Source retention must not run');
      },
      () => {},
    ),
  ).toThrow('Refinement cannot change item type');
  expect(r.f.work.read('studio', r.f.actor)).toEqual(before);
});
