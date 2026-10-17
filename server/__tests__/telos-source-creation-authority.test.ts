import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  TelosSourceAdoptRequestSchema,
  TelosSourceCreateRequestSchema,
  type TelosOutcomeCreation,
} from '@mitzo/protocol';
import { TelosSourceCapture } from '../telos-source-capture.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const changes = [
  'source-policy',
  'hidden',
  'external-import',
  'material-policy',
  'material-bytes',
] as const;
type Change = (typeof changes)[number];

async function fixture() {
  const data = createTelosSourceApprovalData();
  cleanups.push(() => data.close());
  const db = new Database(data.dbPath);
  cleanups.push(() => db.close());
  let sourceAllowed = true;
  const capture = new TelosSourceCapture({
    events: data.events,
    artifacts: data.artifacts,
    work: data.work,
    authorizeSource: (actor, id) =>
      actor.id === data.actor.id && id === 'planning' && sourceAllowed,
    authorizeArtifact: (actor, id) =>
      actor.id === data.actor.id && data.artifacts.userUploadAllowed(id),
  });
  const selected = data.events
    .getEventsAfter('planning', 0, 100)
    .find((event) => event.type === 'user_message' && event.payload.messageId === 'approved')!;
  const proposal = {
    requestId: randomUUID(),
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning',
      mode: 'selected' as const,
      boundary: { sequence: selected.seq, messageId: 'approved' },
      messageIds: ['approved'],
      artifacts: [
        {
          artifactId: data.material.id,
          revision: data.material.revision,
          sha256: data.material.sha256,
        },
      ],
      purpose: 'Retain exactly the reviewed source',
      joiningBrief: '',
    },
    outcome: {
      summary: 'Reviewed studio outcome',
      intent: 'Record clearly',
      rationale: 'Make music',
      acceptanceCriteria: ['Acoustic plan approved'],
      profile: 'personal',
      milestones: ['Install reviewed panels'],
    },
  };
  const preview = await capture.previewNew(proposal, data.actor);
  const input = TelosSourceCreateRequestSchema.parse({
    ...proposal,
    previewSha256: preview.sha256,
  });
  const retained = () =>
    data.work.sourceCreation(input.requestId, hash(JSON.stringify(input)), data.actor);
  const deny = (change: Change) => {
    if (change === 'source-policy') {
      sourceAllowed = false;
      return () => {
        sourceAllowed = true;
      };
    }
    if (change === 'hidden') {
      expect(data.hideOriginalSource()).toBe(true);
      return () => {
        expect(data.restoreOriginalSourceAccess()).toBe(true);
      };
    }
    if (change === 'external-import') {
      data.events.upsertSession({ sessionId: 'planning', conversationSource: 'external_import' });
      return () =>
        data.events.upsertSession({ sessionId: 'planning', conversationSource: 'mitzo' });
    }
    if (change === 'material-policy') {
      db.prepare('UPDATE items SET profile=? WHERE id=?').run('LifeOps', 'studio');
      expect(data.artifacts.userUploadAllowed('studio')).toBe(false);
      return () => {
        db.prepare('UPDATE items SET profile=? WHERE id=?').run('personal', 'studio');
      };
    }
    const original = data.artifacts.read(data.material.id, data.material.revision).bytes;
    db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?').run(
      Buffer.from('UNREVIEWED CORRUPT MATERIAL'),
      data.material.id,
      data.material.revision,
    );
    return () => {
      db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?').run(
        original,
        data.material.id,
        data.material.revision,
      );
    };
  };
  return { ...data, capture, input, preview, retained, deny };
}

it.each(changes)(
  'refuses unfinished creation after %s changes, then resumes the same packet and key',
  async (change) => {
    const f = await fixture();
    const creator = vi
      .fn(f.createOutcome)
      .mockRejectedValueOnce(Error('Canonical unavailable before write'));
    await expect(f.capture.createReviewed(f.input, f.actor, creator)).rejects.toThrow(
      /before write/,
    );
    const prepared = f.retained()!;
    expect(prepared).toMatchObject({ packet: f.preview.packet, itemId: null, receipt: null });
    expect(f.retainedOwnerCounts().canonicalCreates).toBe(0);
    const restore = f.deny(change);
    const before = f.retainedOwnerCounts();
    await expect(f.capture.createReviewed(f.input, f.actor, creator)).rejects.toThrow();
    expect(creator).toHaveBeenCalledTimes(1);
    expect(f.retainedOwnerCounts()).toEqual(before);
    expect(f.retained()).toEqual(prepared);

    restore();
    f.events.upsertSession({ sessionId: 'planning', summary: 'Retitled after original consent' });
    f.events.append('planning', 'user_message', {
      messageId: 'later',
      text: 'Later unreviewed discussion',
    });
    f.advanceMaterial();
    const compile = vi.spyOn(f.capture, 'previewNew');
    const receipt = await f.capture.createReviewed(f.input, f.actor, creator);
    expect(compile).not.toHaveBeenCalled();
    expect(creator).toHaveBeenCalledTimes(2);
    expect(creator.mock.calls.map(([body]) => body.idempotencyKey)).toEqual([
      prepared.idempotencyKey,
      prepared.idempotencyKey,
    ]);
    expect(
      f.capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, f.actor).packet,
    ).toEqual(f.preview.packet);
    expect(receipt.work).toMatchObject({
      assignments: [],
      attempts: [],
      links: [{ role: 'origin' }],
    });
    expect(f.retainedOwnerCounts()).toMatchObject({
      canonicalCreates: 1,
      sources: 1,
      creationAttempts: 1,
      allocations: 0,
    });
  },
);

it.each(changes)(
  'stops unfinished source side effects when %s changes during canonical creation',
  async (change) => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creator = vi.fn(async (body: TelosOutcomeCreation) => {
      entered();
      await gate;
      return f.createOutcome(body);
    });
    const pending = f.capture.createReviewed(f.input, f.actor, creator);
    await started;
    const prepared = f.retained()!;
    const restore = f.deny(change);
    const before = f.retainedOwnerCounts();
    const denied = expect(pending).rejects.toThrow();
    release();
    await denied;
    // The already-authorized external call may have committed; capture must not
    // copy retained source/material bytes or add links after authority changes.
    expect(creator).toHaveBeenCalledTimes(1);
    expect(f.retainedOwnerCounts()).toMatchObject({
      artifactRevisions: before.artifactRevisions,
      sources: before.sources,
      links: before.links,
      canonicalCreates: 1,
      allocations: 0,
    });
    expect(f.retained()?.packet).toEqual(prepared.packet);
    expect(f.retained()?.idempotencyKey).toBe(prepared.idempotencyKey);
    restore();
    const receipt = await f.capture.createReviewed(f.input, f.actor, creator);
    expect(
      creator.mock.calls.every(([body]) => body.idempotencyKey === prepared.idempotencyKey),
    ).toBe(true);
    expect(f.retainedOwnerCounts()).toMatchObject({
      canonicalCreates: 1,
      sources: 1,
      creationAttempts: 1,
      allocations: 0,
    });
    expect(
      f.capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, f.actor).packet,
    ).toEqual(f.preview.packet);
  },
);

it.each(changes)(
  'returns an already completed receipt after %s changes without any new owner effect',
  async (change) => {
    const f = await fixture();
    const creator = vi.fn(f.createOutcome);
    const receipt = await f.capture.createReviewed(f.input, f.actor, creator);
    f.deny(change);
    const before = f.retainedOwnerCounts();
    const compile = vi.spyOn(f.capture, 'previewNew');
    expect(await f.capture.createReviewed(f.input, f.actor, creator)).toEqual(receipt);
    expect(creator).toHaveBeenCalledTimes(1);
    expect(compile).not.toHaveBeenCalled();
    expect(f.retainedOwnerCounts()).toEqual(before);
  },
);

it('checks authority when the canonical item is already recorded but its source packet is not saved', async () => {
  const f = await fixture();
  const creator = vi.fn(f.createOutcome);
  vi.spyOn(f.artifacts, 'save').mockImplementationOnce(() => {
    throw Error('Artifact owner unavailable');
  });
  await expect(f.capture.createReviewed(f.input, f.actor, creator)).rejects.toThrow(
    /Artifact owner/,
  );
  expect(f.retained()).toMatchObject({ itemId: 'created-1', receipt: null });
  const restore = f.deny('source-policy');
  const before = f.retainedOwnerCounts();
  await expect(f.capture.createReviewed(f.input, f.actor, creator)).rejects.toThrow();
  expect(f.retainedOwnerCounts()).toEqual(before);
  expect(creator).toHaveBeenCalledTimes(1);
  restore();
  const receipt = await f.capture.createReviewed(f.input, f.actor, creator);
  expect(creator).toHaveBeenCalledTimes(1);
  expect(
    f.capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, f.actor).packet,
  ).toEqual(f.preview.packet);
});

it.each(changes)(
  'refuses an unfinished adoption artifact retry after %s changes without adding a source/backlink',
  async (change) => {
    const f = await fixture();
    // Keep the material's policy independent of the adoption target revision.
    const target =
      change === 'material-policy'
        ? (await f.createOutcome({ ...f.input.outcome, idempotencyKey: randomUUID() })).itemId
        : 'studio';
    const originalCanonicalCalls = f.retainedOwnerCounts().canonicalCalls;
    const preview = await f.capture.preview(
      { itemId: target, selection: f.input.selection },
      f.actor,
    );
    const input = TelosSourceAdoptRequestSchema.parse({
      itemId: target,
      requestId: randomUUID(),
      selection: f.input.selection,
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
    });
    vi.spyOn(f.work, 'execute').mockImplementationOnce(() => {
      throw Error('Relationship owner unavailable');
    });
    await expect(f.capture.adopt(input, f.actor)).rejects.toThrow(/Relationship owner/);
    expect(f.retainedOwnerCounts()).toMatchObject({
      artifactRevisions: 2,
      sources: 0,
      workLinks: 0,
    });
    const restore = f.deny(change);
    const before = f.retainedOwnerCounts();
    await expect(f.capture.adopt(input, f.actor)).rejects.toThrow();
    expect(f.retainedOwnerCounts()).toEqual(before);
    restore();
    const compile = vi.spyOn(f.capture, 'preview');
    const receipt = await f.capture.adopt(input, f.actor);
    expect(compile).not.toHaveBeenCalled();
    expect(f.capture.read(target, receipt.work.sources[0].snapshotId, f.actor).packet).toEqual(
      preview.packet,
    );
    expect(f.retainedOwnerCounts()).toMatchObject({
      artifactRevisions: 2,
      sources: 1,
      workLinks: 1,
      canonicalCalls: originalCanonicalCalls,
      allocations: 0,
    });
  },
);

it.each(changes)(
  'recovers a completed adoption work receipt after %s changes without new effects',
  async (change) => {
    const f = await fixture();
    const preview = await f.capture.preview(
      { itemId: 'studio', selection: f.input.selection },
      f.actor,
    );
    const input = TelosSourceAdoptRequestSchema.parse({
      itemId: 'studio',
      requestId: randomUUID(),
      selection: f.input.selection,
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
    });
    const receipt = await f.capture.adopt(input, f.actor);
    f.deny(change);
    const before = f.retainedOwnerCounts();
    expect(await f.capture.adopt(input, f.actor)).toEqual(receipt);
    expect(f.retainedOwnerCounts()).toEqual(before);
  },
);

it('recovers a completed source work receipt when final creation bookkeeping was interrupted', async () => {
  const f = await fixture();
  const creator = vi.fn(f.createOutcome);
  vi.spyOn(f.work, 'completeSourceCreation').mockImplementationOnce(() => {
    throw Error('Creation receipt write interrupted');
  });
  await expect(f.capture.createReviewed(f.input, f.actor, creator)).rejects.toThrow(
    /receipt write/,
  );
  expect(f.retained()).toMatchObject({ itemId: 'created-1', receipt: null });
  expect(f.retainedOwnerCounts()).toMatchObject({ sources: 1, workLinks: 1 });
  f.deny('hidden');
  f.deny('material-policy');
  const before = f.retainedOwnerCounts();
  const saved = await f.capture.createReviewed(f.input, f.actor, creator);
  expect(creator).toHaveBeenCalledTimes(1);
  expect(f.retained()?.receipt).toEqual(saved);
  expect(f.retainedOwnerCounts()).toEqual(before);
});

it('runs a host denial before a new work apply without retaining any mutation or receipt', async () => {
  const f = await fixture();
  const input = {
    operation: 'link',
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: f.work.read('studio', f.actor).revision,
    role: 'origin',
    conversation: { namespace: 'mitzo', conversationId: 'planning' },
  };
  const before = f.retainedOwnerCounts();
  const deny = vi.fn(() => {
    throw Error('Current host authority revoked');
  });
  expect(() => f.work.execute(input, f.actor, deny)).toThrow(/revoked/);
  expect(deny).toHaveBeenCalledTimes(1);
  expect(f.retainedOwnerCounts()).toEqual(before);
});

it('checks exact saved command identity before consulting a new-apply host callback', async () => {
  const f = await fixture();
  const input = {
    operation: 'link',
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: f.work.read('studio', f.actor).revision,
    role: 'origin',
    conversation: { namespace: 'mitzo', conversationId: 'planning' },
  };
  const allow = vi.fn();
  const receipt = f.work.execute(input, f.actor, allow);
  expect(allow).toHaveBeenCalledTimes(1);
  const deny = vi.fn(() => {
    throw Error('Current host authority revoked');
  });
  expect(f.work.execute(input, f.actor, deny)).toEqual(receipt);
  expect(() => f.work.execute({ ...input, role: 'reviewer' }, f.actor, deny)).toThrow(/identity/);
  expect(deny).not.toHaveBeenCalled();
});
