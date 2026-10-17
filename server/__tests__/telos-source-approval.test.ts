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
  it.each(
    ['empty', 'whitespace', 'blank-activity', 'tool-only'].flatMap((shape) =>
      (
        [
          { kind: 'create', marker: 'sdk' },
          { kind: 'adopt', marker: 'native' },
        ] as const
      ).map((operation) => ({ shape, ...operation })),
    ),
  )(
    'keeps valid $kind/$marker candidates around an ineligible $shape boundary',
    async ({ shape, kind, marker }) => {
      const f = fixture();
      const append = (type: string, fields: Record<string, unknown> = {}) =>
        f.events.append('planning', type, { messageId: 'blank-candidate', ...fields });
      append('message_start');
      if (shape === 'blank-activity' || shape === 'tool-only') {
        append('block_start', { blockId: 'private', blockType: 'tool_use' });
        append('tool_result', { blockId: 'private', content: 'PRIVATE CANDIDATE ACTIVITY' });
        append('block_end', { blockId: 'private', blockType: 'tool_use' });
      }
      if (shape !== 'tool-only') {
        append('block_start', { blockId: 'blank-public', blockType: 'text' });
        append('block_delta', { blockId: 'blank-public', delta: shape === 'empty' ? '' : ' \n\t' });
        append('block_end', { blockId: 'blank-public', blockType: 'text' });
      }
      const blankSequence = append('message_end');
      const laterSequence = f.events.append('planning', 'user_message', {
        messageId: 'after-blank',
        text: 'Visible discussion after the blank candidate.',
      });
      const permission = await f.request({ kind, marker });
      const permId = String(permission.permId);
      const review = await f.service.review(permId, 'planning', f.actor);
      const blank = review.messages.find((message) => message.messageId === 'blank-candidate');
      if (shape === 'tool-only') expect(blank).toBeUndefined();
      else expect(blank?.unavailableReason).toMatch(/visible public text.*boundary/);
      expect(JSON.stringify(review)).not.toContain('PRIVATE CANDIDATE ACTIVITY');
      const earlier = review.messages.find((message) => message.messageId === 'approved')!;
      const later = review.messages.find((message) => message.messageId === 'after-blank')!;
      expect(earlier.blocks[0].blockId).toBe('user-approved');
      expect(later).toMatchObject({ sequence: laterSequence, unavailableReason: null });
      expect(later.blocks[0].blockId).toBe('user-after-blank');
      const input = (sequence: number, messageId: string) => ({
        sessionId: 'planning',
        requestId: randomUUID(),
        proposalSha256: review.proposalSha256,
        selection: {
          mode: 'selected' as const,
          boundary: { sequence, messageId },
          messageIds: [messageId],
          artifacts: [],
        },
      });
      const counts = () => {
        const db = new Database(f.dbPath, { readonly: true });
        try {
          return Object.fromEntries(
            [
              'items',
              'sources',
              'links',
              'telos_artifact_revisions',
              'telos_work_sources',
              'telos_work_links',
              'telos_work_assignments',
              'telos_work_attempts',
              'telos_work_commands',
              'telos_work_source_creations',
              'telos_work_source_approvals',
            ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()]),
          );
        } finally {
          db.close();
        }
      };
      const before = counts();
      for (const message of [earlier, later]) {
        const preview = await f.service.preview(
          permId,
          input(message.sequence, message.messageId),
          f.actor,
        );
        expect(
          preview.preview.packet.context.messages.map((selected) => selected.messageId),
        ).toEqual([message.messageId]);
        expect(preview.preview.packet.context.messages[0].blocks).toEqual(message.blocks);
      }
      const invalid = input(blankSequence, 'blank-candidate');
      await expect(f.service.preview(permId, invalid, f.actor)).rejects.toThrow(
        /visible public text.*boundary/,
      );
      await expect(
        f.service.approve(permId, { ...invalid, previewSha256: '0'.repeat(64) }, f.actor),
      ).rejects.toThrow(/visible public text.*boundary/);
      expect(counts()).toEqual(before);
      expect(f.counts()).toMatchObject({
        canonicalCreates: 0,
        allocations: 0,
        sources: { total: 0 },
      });
    },
  );

  it.each(['payload-provenance', 'private-id-reuse'] as const)(
    'keeps candidate inspection fail-closed for %s',
    async (invalid) => {
      const f = fixture();
      const append = (type: string, fields: Record<string, unknown> = {}) =>
        f.events.append('planning', type, { messageId: 'unqualified-candidate', ...fields });
      append('message_start');
      append('block_start', { blockId: 'public', blockType: 'text' });
      append('block_delta', {
        blockId: 'public',
        delta: 'Public candidate',
        ...(invalid === 'payload-provenance' ? { seatId: null } : {}),
      });
      if (invalid === 'private-id-reuse') {
        append('block_start', { blockId: 'public', blockType: 'thinking' });
        append('block_delta', { blockId: 'public', delta: 'PRIVATE REUSED CANDIDATE' });
      }
      append('block_end', {
        blockId: 'public',
        blockType: invalid === 'private-id-reuse' ? 'thinking' : 'text',
      });
      append('message_end');
      f.events.append('planning', 'user_message', {
        messageId: 'after-invalid',
        text: 'Later public message',
      });
      const permission = await f.request({ kind: 'create', marker: 'native' });
      const before = f.counts();
      await expect(
        f.service.review(String(permission.permId), 'planning', f.actor),
      ).rejects.toThrow();
      expect(f.counts()).toEqual(before);
      const db = new Database(f.dbPath, { readonly: true });
      try {
        expect(
          db.prepare('SELECT COUNT(*) AS total FROM telos_work_source_approvals').get(),
        ).toEqual({ total: 0 });
        expect(
          db.prepare('SELECT COUNT(*) AS total FROM telos_work_source_creations').get(),
        ).toEqual({ total: 0 });
      } finally {
        db.close();
      }
    },
  );

  it('keeps a later visible public block eligible without stripping its earlier blank block', async () => {
    const f = fixture();
    const append = (type: string, fields: Record<string, unknown> = {}) =>
      f.events.append('planning', type, { messageId: 'mixed-public', ...fields });
    append('message_start');
    for (const [blockId, delta] of [
      ['blank', ' \n'],
      ['visible', 'Later visible public text'],
    ]) {
      append('block_start', { blockId, blockType: 'text' });
      append('block_delta', { blockId, delta });
      append('block_end', { blockId, blockType: 'text' });
    }
    const sequence = append('message_end');
    const permission = await f.request({ kind: 'create', marker: 'sdk' });
    const permId = String(permission.permId);
    const review = await f.service.review(permId, 'planning', f.actor);
    const candidate = review.messages.find((message) => message.messageId === 'mixed-public')!;
    expect(candidate.unavailableReason).toBeNull();
    const preview = await f.service.preview(
      permId,
      {
        sessionId: 'planning',
        requestId: randomUUID(),
        proposalSha256: review.proposalSha256,
        selection: {
          mode: 'selected',
          boundary: { sequence, messageId: 'mixed-public' },
          messageIds: ['mixed-public'],
          artifacts: [],
        },
      },
      f.actor,
    );
    expect(preview.preview.packet.context.messages[0].blocks).toEqual(candidate.blocks);
    expect(candidate.blocks.map((block) => block.content)).toEqual([
      ' \n',
      'Later visible public text',
    ]);
  });

  it.each(['create', 'adopt'] as const)(
    'resumes a prepared %s before canonical capture starts from its exact immutable preview',
    async (kind) => {
      const f = fixture();
      const s = await selected(f, kind);
      if (kind === 'create')
        vi.spyOn(f.service.capture, 'createReviewed').mockRejectedValueOnce(
          new Error('Interrupted before canonical owner preparation'),
        );
      else
        vi.spyOn(f.service.capture, 'adopt').mockRejectedValueOnce(
          new Error('Interrupted before canonical owner preparation'),
        );
      await expect(f.service.approve(s.permId, s.approved, f.actor)).rejects.toThrow(/uncertain/);
      const db = new Database(f.dbPath, { readonly: true });
      try {
        expect(
          db.prepare('SELECT COUNT(*) AS total FROM telos_work_source_approvals').get(),
        ).toEqual({ total: 1 });
        expect(
          db.prepare('SELECT COUNT(*) AS total FROM telos_work_source_creations').get(),
        ).toEqual({ total: 0 });
        expect(db.prepare('SELECT COUNT(*) AS total FROM telos_work_sources').get()).toEqual({
          total: 0,
        });
        expect(db.prepare('SELECT COUNT(*) AS total FROM telos_artifact_revisions').get()).toEqual({
          total: 1,
        });
      } finally {
        db.close();
      }
      expect(f.counts().canonicalCreates).toBe(0);
      f.events.upsertSession({ sessionId: 'planning', summary: 'Renamed after durable consent' });
      expect(f.hideOriginalSource()).toBe(true);
      f.restartOwners();
      const retained = await f.service.review(s.permId, 'planning', f.actor);
      expect(retained.recovery?.preview).toEqual(s.preview.preview);
      await expect(
        f.service.approve(s.permId, s.approved, { kind: 'operator', id: 'another-operator' }),
      ).rejects.toThrow(/another operator/);
      const previewNew = vi.spyOn(f.service.capture, 'previewNew');
      const preview = vi.spyOn(f.service.capture, 'preview');
      const receipt = await f.service.approve(s.permId, s.approved, f.actor);
      expect(previewNew).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
      expect(f.receiptSource(receipt).packet).toEqual(s.preview.preview.packet);
      expect(await f.service.approve(s.permId, s.approved, f.actor)).toEqual(receipt);
      expect((await f.service.review(s.permId, 'planning', f.actor)).recovery).toMatchObject({
        preview: s.preview.preview,
        receipt,
      });
      expect(f.counts()).toMatchObject({
        canonicalCreates: kind === 'create' ? 1 : 0,
        allocations: 0,
        sources: { total: 1 },
      });
    },
  );

  it('reviews and retains linked full-prefix material bytes at the exact original revision through approval and recovery', async () => {
    const f = fixture();
    const original = f.artifacts.read(f.material.id, f.material.revision);
    const sequence = f.events.append('planning', 'user_message', {
      messageId: 'linked-material',
      text: `[Reviewed acoustic plan][approved]\n\n[approved]: ${f.material.url} "Approved original"`,
    });
    const permission = await f.request({ kind: 'create', marker: 'sdk' });
    const permId = String(permission.permId);
    const review = await f.service.review(permId, 'planning', f.actor);
    expect(
      review.messages.find((message) => message.messageId === 'linked-material'),
    ).toMatchObject({
      sequence,
      blocks: [{ blockId: 'user-linked-material' }],
    });
    const input = {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.proposalSha256,
      selection: {
        mode: 'conversation_so_far' as const,
        boundary: { sequence, messageId: 'linked-material' },
        messageIds: [],
        artifacts: [],
      },
    };
    const preview = await f.service.preview(permId, input, f.actor);
    const pin = {
      artifactId: f.material.id,
      revision: f.material.revision,
      sha256: f.material.sha256,
      contentBase64: original.bytes.toString('base64'),
    };
    expect.soft(preview.preview.packet.context.artifacts).toMatchObject([pin]);
    const later = f.advanceMaterial();
    expect(later.revision).toBeGreaterThan(f.material.revision);
    expect(later.sha256).not.toBe(f.material.sha256);
    const approved = { ...input, previewSha256: preview.preview.sha256 };
    const receipt = await f.service.approve(permId, approved, f.actor);
    expect(await f.settled()).toMatchObject({ sourceSnapshotId: receipt.sourceSnapshotId });
    const retained = f.receiptSource(receipt);
    expect.soft(retained.packet.context.artifacts).toMatchObject([pin]);
    expect(retained.packet).toEqual(preview.preview.packet);
    expect(receipt.receipt.work.assignments).toEqual([]);
    expect(f.counts()).toMatchObject({
      canonicalCreates: 1,
      allocations: 0,
      sources: { total: 1 },
    });
    expect(f.hideOriginalSource()).toBe(true);
    f.restartOwners();
    const recovered = await f.service.review(permId, 'planning', f.actor);
    expect(recovered.recovery?.preview).toEqual(preview.preview);
    expect(recovered.recovery?.receipt).toEqual(receipt);
    expect(await f.service.approve(permId, approved, f.actor)).toEqual(receipt);
    expect(f.receiptSource(receipt).packet).toEqual(preview.preview.packet);
    expect(f.counts()).toMatchObject({ canonicalCreates: 1, sources: { total: 1 } });
  });

  it('refuses mutable full-prefix material through the real permission service before preparing approval or mutating retained and canonical owners', async () => {
    const f = fixture();
    const sequence = f.events.append('planning', 'user_message', {
      messageId: 'mutable-material',
      text: `Saved /api/telos/artifacts/${f.material.id}.`,
    });
    const permission = await f.request({ kind: 'create', marker: 'native' });
    const permId = String(permission.permId);
    const review = await f.service.review(permId, 'planning', f.actor);
    expect(review.messages.some((message) => message.messageId === 'mutable-material')).toBe(true);
    const input = {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.proposalSha256,
      selection: {
        mode: 'conversation_so_far' as const,
        boundary: { sequence, messageId: 'mutable-material' },
        messageIds: [],
        artifacts: [],
      },
    };
    const retainedCounts = () => {
      const db = new Database(f.dbPath, { readonly: true });
      try {
        return Object.fromEntries(
          [
            'items',
            'sources',
            'links',
            'telos_artifact_revisions',
            'telos_work_sources',
            'telos_work_links',
            'telos_work_assignments',
            'telos_work_attempts',
            'telos_work_commands',
            'telos_work_source_creations',
            'telos_work_source_approvals',
          ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()]),
        );
      } finally {
        db.close();
      }
    };
    const before = retainedCounts();
    let previewRefused = false;
    let previewSha256 = '0'.repeat(64);
    try {
      previewSha256 = (await f.service.preview(permId, input, f.actor)).preview.sha256;
    } catch {
      previewRefused = true;
    }
    expect.soft(previewRefused).toBe(true);
    let approvalRefused = false;
    try {
      await f.service.approve(permId, { ...input, previewSha256 }, f.actor);
      await f.settled();
    } catch {
      approvalRefused = true;
    }
    expect.soft(approvalRefused).toBe(true);
    expect.soft(retainedCounts()).toEqual(before);
    expect.soft(f.counts()).toMatchObject({
      canonicalCreates: 0,
      allocations: 0,
      sources: { total: 0 },
    });
  });

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
