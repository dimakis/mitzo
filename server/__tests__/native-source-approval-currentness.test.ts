import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  buildPermissionHandler,
  getPendingRequestsBySession,
  getPendingTelosSourceReview,
  registerPending,
} from '@mitzo/harness';
import { TelosSourceApproval } from '../telos-source-approval.js';
import { TelosSourceApprovalStore } from '../telos-source-approval-store.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';
import type { TelosOutcomeCreation } from '@mitzo/protocol';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
});
async function selected(
  kind: 'create' | 'adopt',
  creator?: (body: TelosOutcomeCreation, guard?: () => void) => Promise<{ itemId: string }>,
) {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const store = new TelosSourceApprovalStore(f.dbPath);
  cleanup.push(() => store.close());
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  let current = true;
  const service = new TelosSourceApproval({
    events: f.events,
    artifacts: f.artifacts,
    work: f.work,
    store,
    createOutcome: creator ?? f.createOutcome,
  });
  const proposal =
    kind === 'adopt'
      ? { itemId: 'studio' }
      : {
          summary: 'Reviewed output',
          intent: 'Create the reviewed work',
          rationale: 'Preserve exact source',
          acceptanceCriteria: ['Exact source retained'],
          profile: 'personal',
          milestones: ['Reviewed milestone'],
        };
  const result = buildPermissionHandler('offline-client', f.registry)(
    kind === 'create' ? 'TelosCreateOutcome' : 'TelosAdoptSource',
    proposal,
    {
      signal: controller.signal,
      toolUseID: 'native:' + randomUUID(),
      forcePrompt: true,
      allowSessionGrant: false,
      nativeSourceScope: {
        operatorId: f.actor.id,
        assertCurrentSync() {
          if (!current) throw Error('native retired');
        },
      },
    },
  );
  void result.catch(() => {});
  await vi.waitFor(() => expect(getPendingRequestsBySession('planning')).toHaveLength(1));
  const permId = getPendingRequestsBySession('planning')[0].permId;
  const proof = getPendingTelosSourceReview(permId, 'planning')!;
  const review = await service.review(permId, 'planning', f.actor);
  const m = review.messages.find((m) => m.messageId === 'approved')!;
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: m.sequence, messageId: m.messageId },
      messageIds: [m.messageId],
      artifacts: [],
    },
  };
  const preview = await service.preview(permId, input, f.actor);
  return {
    f,
    service,
    store,
    permId,
    proof,
    proposal,
    result,
    input: { ...input, previewSha256: preview.preview.sha256 },
    retire() {
      current = false;
    },
  };
}

it('binds a new source review to the original native operator, not another legitimate login', async () => {
  const a = await selected('adopt');
  await expect(
    a.service.review(a.permId, 'planning', { kind: 'operator', id: 'different-signed-login' }),
  ).rejects.toThrow();
});

it.each(['create', 'adopt'] as const)(
  'refuses retired native permission before fresh %s canonical mutations',
  async (kind) => {
    const a = await selected(kind);
    const counts = a.f.retainedOwnerCounts();
    if (kind === 'create') {
      const original = a.service.capture.createReviewed.bind(a.service.capture);
      vi.spyOn(a.service.capture, 'createReviewed').mockImplementationOnce(async (...args) => {
        a.retire();
        return original(...args);
      });
    } else {
      const original = a.service.capture.adopt.bind(a.service.capture);
      vi.spyOn(a.service.capture, 'adopt').mockImplementationOnce(async (...args) => {
        a.retire();
        return original(...args);
      });
    }
    await expect(a.service.approve(a.permId, a.input, a.f.actor)).rejects.toThrow();
    expect(a.f.retainedOwnerCounts()).toMatchObject({
      canonicalCreates: counts.canonicalCreates,
      artifactRevisions: counts.artifactRevisions,
      sources: counts.sources,
      workLinks: counts.workLinks,
      allocations: counts.allocations,
    });
  },
);

it('does not transfer captured approval authority to an identical replacement permission object', async () => {
  const a = await selected('adopt');
  const original = a.service.capture.adopt.bind(a.service.capture);
  vi.spyOn(a.service.capture, 'adopt').mockImplementationOnce(async (...args) => {
    registerPending(
      a.permId,
      a.proof.toolName,
      vi.fn(),
      a.proof.toolInput,
      undefined,
      a.proof.sessionId,
      {
        permId: a.permId,
        sessionId: a.proof.sessionId,
        toolName: a.proof.toolName,
        toolInput: 'same',
        reviewKind: 'telos_source',
        expiresAt: a.proof.expiresAt,
      },
      { toolUseId: a.proof.toolUseId },
    );
    return original(...args);
  });
  await expect(a.service.approve(a.permId, a.input, a.f.actor)).rejects.toThrow();
  expect(a.f.retainedOwnerCounts().sources).toBe(0);
});

it('forwards the original pending fence to actual canonical creator dispatch', async () => {
  const a = await selected('create');
  let forwarded: (() => void) | undefined;
  const actual = a.f.createOutcome;
  const service = new TelosSourceApproval({
    events: a.f.events,
    artifacts: a.f.artifacts,
    work: a.f.work,
    store: a.store,
    createOutcome: async (body, guard) => {
      forwarded = guard;
      a.retire();
      guard?.();
      return actual(body);
    },
  });
  await expect(service.approve(a.permId, a.input, a.f.actor)).rejects.toThrow();
  expect(typeof forwarded).toBe('function');
  expect(a.f.retainedOwnerCounts().canonicalCreates).toBe(0);
});

it('retains the actual canonical creation acknowledgement after retirement, without new source artifacts/backlinks', async () => {
  const a = await selected('create');
  const service = new TelosSourceApproval({
    events: a.f.events,
    artifacts: a.f.artifacts,
    work: a.f.work,
    store: a.store,
    createOutcome: async (body, guard) => {
      guard?.();
      const created = await a.f.createOutcome(body);
      a.retire();
      return created;
    },
  });
  await expect(service.approve(a.permId, a.input, a.f.actor)).rejects.toThrow();
  const record = a.store.lookup(a.permId, 'planning', 'operator:' + a.f.actor.id)!;
  expect(a.store.canonical(record.id)?.item.id).toBe('created-1');
  expect(a.f.retainedOwnerCounts()).toMatchObject({
    canonicalCreates: 1,
    artifactRevisions: 1,
    sources: 0,
    workLinks: 0,
  });
});

it('recovers the same completed source receipt without reopening retired native mutation authority', async () => {
  const a = await selected('adopt');
  const receipt = await a.service.approve(a.permId, a.input, a.f.actor);
  await a.result;
  const counts = a.f.retainedOwnerCounts();
  a.retire();
  expect(await a.service.approve(a.permId, a.input, a.f.actor)).toEqual(receipt);
  expect(
    a.service.execute(
      a.store.lookup(a.permId, 'planning', 'operator:' + a.f.actor.id)!.id,
      'planning',
      a.proposal,
    ).receipt,
  ).toEqual(receipt.receipt);
  expect(a.f.retainedOwnerCounts()).toEqual(counts);
});

it.each(['create', 'adopt'] as const)(
  'retains native refusal provenance across prepared %s restart recovery',
  async (kind) => {
    const a = await selected(kind);
    const method = kind === 'create' ? 'createReviewed' : 'adopt';
    vi.spyOn(a.service.capture, method).mockRejectedValueOnce(Error('lost before capture'));
    await expect(a.service.approve(a.permId, a.input, a.f.actor)).rejects.toThrow();
    const record = a.store.lookup(a.permId, 'planning', 'operator:' + a.f.actor.id)!;
    expect(record.requiresLiveNativeCall).toBe(true);
    expect(JSON.stringify(await a.service.review(a.permId, 'planning', a.f.actor))).not.toContain(
      'requiresLiveNativeCall',
    );
    const db = new Database(a.f.dbPath);
    try {
      expect(() =>
        db
          .prepare('UPDATE telos_work_source_approvals SET data=? WHERE id=?')
          .run(JSON.stringify({ ...record, requiresLiveNativeCall: undefined }), record.id),
      ).toThrow(/immutable/);
    } finally {
      db.close();
    }
    const counts = a.f.retainedOwnerCounts();
    a.retire();
    a.f.restartOwners();
    await expect(a.f.service.approve(a.permId, a.input, a.f.actor)).rejects.toThrow();
    expect(a.f.retainedOwnerCounts()).toEqual(counts);
  },
);
