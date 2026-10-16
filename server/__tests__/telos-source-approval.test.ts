import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolvePending, SessionRegistry, buildPermissionHandler } from '@mitzo/harness';
import { TelosSourceApprovalStore } from '../telos-source-approval-store.js';
import Database from 'better-sqlite3';
import { formatTelosSourceResult } from '../telos-tool.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
});
function fixture() {
  const data = createTelosSourceApprovalData();
  cleanups.push(() => data.close());
  return data;
}
async function selected(
  f: ReturnType<typeof fixture>,
  kind: 'create' | 'adopt' = 'create',
  marker: 'native' | 'sdk' = 'native',
  messageId = 'approved',
) {
  const permission = await f.request({ kind, marker });
  const permId = String(permission.permId);
  const review = await f.service.review(permId, 'planning', f.actor);
  const message = review.messages.find((message) => message.messageId === messageId)!;
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId },
      messageIds: [messageId],
      artifacts: [
        { artifactId: f.material.id, revision: f.material.revision, sha256: f.material.sha256 },
      ],
    },
  };
  const preview = await f.service.preview(permId, input, f.actor);
  return {
    permId,
    review,
    input,
    approved: { ...input, previewSha256: preview.preview.sha256 },
    preview,
  };
}
describe('actual ordinary Telos source approval owners', () => {
  it('preserves canonical created:false and full metadata after a lost canonical reply, restart and stable replay', async () => {
    const f = fixture(),
      s = await selected(f);
    f.loseNextCanonicalResponse();
    await expect(f.service.approve(s.permId, s.approved, f.actor)).rejects.toThrow(/uncertain/);
    expect(f.counts().canonicalCreates).toBe(1);
    f.restartOwners();
    const receipt = await f.service.approve(s.permId, s.approved, f.actor);
    expect(receipt.canonicalCreation).toMatchObject({
      ok: true,
      created: false,
      item: { id: receipt.receipt.work.itemId },
      delivery: { state: 'retained' },
    });
    expect(
      JSON.parse(formatTelosSourceResult({ ...receipt, operation: s.review.operation }).content),
    ).toMatchObject({ created: false, canonicalCreation: receipt.canonicalCreation });
    expect(await f.service.approve(s.permId, s.approved, f.actor)).toEqual(receipt);
    expect(f.counts().canonicalCreates).toBe(1);
  });
  it('replays prepared recovery from a fresh host owner and resumes the same actual provider invocation', async () => {
    const f = fixture(),
      s = await selected(f, 'create', 'sdk');
    f.loseNextSaveResponse();
    await expect(f.service.approve(s.permId, s.approved, f.actor)).rejects.toThrow(/uncertain/);
    f.restartOwners();
    const replay = f.recoveryRequests();
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      permId: s.permId,
      sessionId: 'planning',
      reviewKind: 'telos_source',
      recoveryOnly: true,
    });
    expect(replay[0].expiresAt).toBeUndefined();
    const registry = new SessionRegistry(),
      controller = new AbortController();
    cleanups.push(() => {
      controller.abort();
      registry.dispose();
    });
    let arrived: Record<string, unknown> | undefined;
    registry.register('resumed-client', {
      sessionId: 'planning',
      transport: {
        isOpen: () => true,
        send: (event) => {
          if (event.type === 'permission_request') arrived = event;
        },
      },
      abortController: controller,
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const proposal = s.review.operation.kind === 'create' ? s.review.operation.outcome : {};
    let resumed: Record<string, unknown> | undefined;
    void buildPermissionHandler('resumed-client', registry)(
      'mcp__telos__TelosCreateOutcome',
      proposal,
      { signal: controller.signal, toolUseID: s.review.toolUseId },
    ).then((result) => {
      resumed = result;
    });
    await vi.waitFor(() => expect(arrived?.permId).toBe(s.permId));
    const recovered = await f.service.review(s.permId, 'planning', f.actor);
    expect(recovered.recovery?.preview).toEqual(s.preview.preview);
    const receipt = await f.service.approve(s.permId, s.approved, f.actor);
    await Promise.resolve();
    expect(resumed?.behavior).toBe('allow');
    const input = resumed!.updatedInput as Record<string, unknown>;
    expect(
      f.service.execute(String(input.__mitzoTelosApproval), 'planning', proposal),
    ).toMatchObject({ sourceSnapshotId: receipt.sourceSnapshotId });
    expect(f.counts().canonicalCreates).toBe(1);
    expect(f.recoveryRequests()).toEqual([]);
  });
  it('retains immutable approval packets and dismissed uncertain saves without deleting their receipts', async () => {
    const f = fixture(),
      s = await selected(f);
    f.loseNextSaveResponse();
    await expect(f.service.approve(s.permId, s.approved, f.actor)).rejects.toThrow();
    f.restartOwners();
    const db = new Database(f.dbPath);
    cleanups.push(() => db.close());
    expect(() => db.prepare("UPDATE telos_work_source_approvals SET data='{}'").run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare('DELETE FROM telos_work_source_approvals').run()).toThrow(/retained/);
    const store = new TelosSourceApprovalStore(f.dbPath);
    cleanups.push(() => store.close());
    expect(store.recoveries('planning', 'operator:other')).toEqual([]);
    expect(store.dismiss(s.permId, 'planning', 'operator:' + f.actor.id)).toBe(true);
    expect(f.recoveryRequests()).toEqual([]);
    expect((await f.service.review(s.permId, 'planning', f.actor)).recovery?.preview).toEqual(
      s.preview.preview,
    );
    expect(f.counts().canonicalCreates).toBe(1);
    expect(f.counts().sources.total).toBe(1);
  });
  it('does not hide later public messages behind a page of non-message delivery anchors', async () => {
    const f = fixture();
    for (let index = 0; index < 52; index++)
      f.events.append('planning', 'symposium_delivery_dispatched', {
        deliveryId: 'delivery-' + index,
      });
    f.events.append('planning', 'user_message', {
      messageId: 'late',
      text: 'Later public discussion.',
    });
    const permission = await f.request({ kind: 'create', marker: 'native' }),
      permId = String(permission.permId);
    const first = await f.service.review(permId, 'planning', f.actor);
    expect(first.hasMore).toBe(true);
    const next = await f.service.review(permId, 'planning', f.actor, first.cursor);
    expect(next.messages.map((message) => message.messageId)).toContain('late');
  });
  it.each(['native', 'sdk'] as const)(
    'reviews and saves one %s proposal then returns only its original retained receipt',
    async (marker) => {
      const f = fixture(),
        s = await selected(f, 'create', marker);
      expect(f.counts().canonicalCreates).toBe(0);
      expect(s.review.messages.map((message) => message.messageId)).toEqual([
        'before',
        'approved',
        'after',
      ]);
      expect(s.preview.preview.packet.context.messages.map((message) => message.messageId)).toEqual(
        ['approved'],
      );
      f.advanceMaterial();
      const receipt = await f.service.approve(s.permId, s.approved, f.actor);
      expect(await f.settled()).toMatchObject({ sourceSnapshotId: receipt.sourceSnapshotId });
      expect(await f.service.approve(s.permId, s.approved, f.actor)).toEqual(receipt);
      expect(f.receiptSource(receipt).packet.context.artifacts[0].sha256).toBe(f.material.sha256);
      expect(f.counts()).toMatchObject({
        canonicalCreates: 1,
        allocations: 0,
        originSessions: ['planning'],
        sources: { total: 1 },
      });
      expect(receipt.receipt.work.assignments).toEqual([]);
      const recovery = await f.service.review(s.permId, 'planning', f.actor);
      expect(recovery.recovery?.preview).toEqual(s.preview.preview);
      expect(recovery.recovery?.receipt).toEqual(receipt);
      await expect(
        f.service.approve(s.permId, { ...s.approved, requestId: randomUUID() }, f.actor),
      ).rejects.toThrow(/exact original/);
    },
  );
  it('adopts into the exact existing item and returns the newly reviewed exchange on each adoption', async () => {
    const f = fixture(),
      first = await selected(f, 'adopt');
    const original = await f.service.approve(first.permId, first.approved, f.actor);
    await f.settled();
    const second = await selected(f, 'adopt', 'sdk', 'after');
    const next = await f.service.approve(second.permId, second.approved, f.actor);
    await f.settled();
    expect(next.receipt.work.itemId).toBe('studio');
    expect(next.sourceSnapshotId).not.toBe(original.sourceSnapshotId);
    expect(
      f.receiptSource(next).packet.context.messages.map((message) => message.messageId),
    ).toEqual(['after']);
    expect(f.counts().canonicalCreates).toBe(0);
  });
  it('refuses generic session/once grants, wrong identities, stale item previews and explicit denial without saving', async () => {
    const f = fixture(),
      s = await selected(f, 'adopt');
    expect(resolvePending(s.permId, 'always', undefined, 'planning')).toBe(false);
    expect(resolvePending(s.permId, 'once', undefined, 'planning')).toBe(false);
    await expect(f.service.review(s.permId, 'another-session', f.actor)).rejects.toThrow();
    expect(() => f.service.execute(randomUUID(), 'planning', {})).toThrow();
    f.staleItem();
    await expect(f.service.approve(s.permId, s.approved, f.actor)).rejects.toThrow(/changed/);
    await f.respond({ permId: s.permId, sessionId: 'planning', decision: 'deny' });
    expect(f.counts()).toMatchObject({ canonicalCreates: 0, sources: { total: 0 }, denials: 1 });
  });
  it('recovers the original prepared input and immutable preview after a lost completed save response', async () => {
    const f = fixture(),
      s = await selected(f);
    const actual = f.service.capture.createReviewed.bind(f.service.capture);
    vi.spyOn(f.service.capture, 'createReviewed').mockImplementationOnce(async (...args) => {
      await actual(...args);
      throw Error('Lost saved response');
    });
    await expect(f.service.approve(s.permId, s.approved, f.actor)).rejects.toThrow();
    f.events.hideSession('planning');
    const restored = await f.service.review(s.permId, 'planning', f.actor);
    expect(restored.recovery?.preview).toEqual(s.preview.preview);
    await expect(
      f.service.review(s.permId, 'planning', { kind: 'operator', id: 'other' }),
    ).rejects.toThrow();
    const receipt = await f.service.approve(s.permId, s.approved, f.actor);
    await f.settled();
    expect(receipt.canonicalCreation).toMatchObject({
      created: true,
      delivery: { state: 'retained' },
    });
    expect(f.counts().canonicalCreates).toBe(1);
    expect(f.receiptSource(receipt).packet).toEqual(s.preview.preview.packet);
  });
});
