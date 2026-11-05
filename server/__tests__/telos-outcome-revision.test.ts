import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getPendingTelosSourceReview, removePending } from '@mitzo/harness';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
async function fixture() {
  const f = createTelosSourceApprovalData();
  cleanups.push(() => f.close());
  const permission = await f.request({ kind: 'create', marker: 'native' });
  const permId = String(permission.permId);
  const review = await f.service.review(permId, 'planning', f.actor);
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    toolUseId: review.toolUseId,
    proposalSha256: review.proposalSha256,
    feedback: 'Make the first milestone a mobile regression test.',
  };
  return { f, permId, review, input };
}
it('returns feedback and the exact draft to the waiting agent without creating work; a revised proposal needs a fresh save', async () => {
  const { f, permId, review, input } = await fixture();
  const before = f.retainedOwnerCounts();
  const receipt = await f.service.requestChanges(permId, input, f.actor);
  await f.settled();
  expect(receipt.kind).toBe('telos_outcome_changes_requested');
  expect(receipt.originalOutcome).toEqual(
    review.operation.kind === 'create' && review.operation.outcome,
  );
  expect(JSON.parse(f.denialMessage()!)).toMatchObject({
    feedback: input.feedback,
    originalOutcome: receipt.originalOutcome,
  });
  expect(getPendingTelosSourceReview(permId, 'planning')).toBeUndefined();
  expect(f.retainedOwnerCounts()).toEqual(before);
  expect(await f.service.requestChanges(permId, input, f.actor)).toEqual(receipt);
  const revised = await f.request({
    kind: 'create',
    marker: 'native',
    summary: 'Test the mobile creation flow first',
  });
  const revisedId = String(revised.permId);
  expect(revisedId).not.toBe(permId);
  const next = await f.service.review(revisedId, 'planning', f.actor);
  expect(next.operation).toMatchObject({
    kind: 'create',
    outcome: { summary: 'Test the mobile creation flow first' },
  });
  expect(f.retainedOwnerCounts()).toEqual(before);
  const message = next.messages[0];
  const selected = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: next.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { messageId: message.messageId, sequence: message.sequence },
      messageIds: [message.messageId],
      artifacts: [],
    },
  };
  const preview = await f.service.preview(revisedId, selected, f.actor);
  await f.service.approve(
    revisedId,
    { ...selected, previewSha256: preview.preview.sha256 },
    f.actor,
  );
  expect(f.counts().canonicalCreates).toBe(1);
});
it('retains an exact feedback receipt across owner restart and refuses changed retries or another operator', async () => {
  const { f, permId, input } = await fixture();
  const receipt = await f.service.requestChanges(permId, input, f.actor);
  await f.settled();
  f.restartOwners();
  expect(await f.service.requestChanges(permId, input, f.actor)).toEqual(receipt);
  await expect(
    f.service.requestChanges(permId, { ...input, feedback: 'Different feedback' }, f.actor),
  ).rejects.toThrow(/original|changed|exact/i);
  await expect(
    f.service.requestChanges(permId, input, { kind: 'operator', id: 'other' }),
  ).rejects.toThrow(/operator|authority/i);
  expect(f.counts().canonicalCreates).toBe(0);
});
it.each(['proposal', 'tool', 'session', 'expired'] as const)(
  'refuses %s changes without revising or writing work',
  async (change) => {
    const { f, permId, input } = await fixture();
    const before = f.retainedOwnerCounts();
    if (change === 'expired') removePending(permId);
    const altered =
      change === 'proposal'
        ? { ...input, proposalSha256: 'e'.repeat(64) }
        : change === 'tool'
          ? { ...input, toolUseId: 'another-invocation' }
          : change === 'session'
            ? { ...input, sessionId: 'another-conversation' }
            : input;
    await expect(f.service.requestChanges(permId, altered, f.actor)).rejects.toThrow();
    expect(f.retainedOwnerCounts()).toEqual(before);
  },
);
it('refuses feedback for a save whose canonical result is uncertain and preserves its exact recovery', async () => {
  const { f, permId, review, input } = await fixture();
  const message = review.messages[0];
  const selected = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { messageId: message.messageId, sequence: message.sequence },
      messageIds: [message.messageId],
      artifacts: [],
    },
  };
  const preview = await f.service.preview(permId, selected, f.actor);
  f.loseNextCanonicalResponse();
  await expect(
    f.service.approve(permId, { ...selected, previewSha256: preview.preview.sha256 }, f.actor),
  ).rejects.toThrow(/uncertain/i);
  await expect(f.service.requestChanges(permId, input, f.actor)).rejects.toThrow(/save|recover/i);
  expect(f.counts().canonicalCreates).toBe(1);
});

it('rechecks the original signed native operator and invocation before delivering feedback', async () => {
  const f = createTelosSourceApprovalData();
  cleanups.push(() => f.close());
  let current = true;
  const permission = await f.request({
    kind: 'create',
    marker: 'native',
    nativeSourceScope: {
      operatorId: f.actor.id,
      assertCurrentSync() {
        if (!current) throw Error('Revoked');
      },
    },
  });
  const permId = String(permission.permId);
  const review = await f.service.review(permId, 'planning', f.actor);
  const input = {
    sessionId: 'planning',
    toolUseId: review.toolUseId,
    proposalSha256: review.proposalSha256,
    requestId: randomUUID(),
    feedback: 'Narrow the first milestone.',
  };
  await expect(
    f.service.requestChanges(permId, input, { kind: 'operator', id: 'other' }),
  ).rejects.toThrow();
  current = false;
  await expect(f.service.requestChanges(permId, input, f.actor)).rejects.toThrow();
  expect(f.denialMessage()).toBeNull();
  current = true;
  await f.service.requestChanges(permId, input, f.actor);
  await f.settled();
  expect(f.denialMessage()).toContain(input.feedback);
  expect(f.counts().canonicalCreates).toBe(0);
});
