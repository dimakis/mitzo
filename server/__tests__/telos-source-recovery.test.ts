import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTelosSourceApprovalData } from '../../tests/fixtures/telos-source-approval-data.js';
import { createTelosSourcePermissionRecovery } from '../telos-source-recovery.js';
import {
  configureTelosSourcePermissionRecovery,
  getPendingRequestsBySession,
  dismissTelosSourcePermissionRecovery,
} from '../permissions.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  configureTelosSourcePermissionRecovery(undefined);
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
it('feeds actual reconnect permission replay only the owning operator prepared save and dismisses without undo', async () => {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const permission = await f.request({ kind: 'create', marker: 'native' }),
    permId = String(permission.permId);
  const review = await f.service.review(permId, 'planning', f.actor),
    message = review.messages[1];
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [],
    },
  };
  const preview = await f.service.preview(permId, input, f.actor);
  f.loseNextSaveResponse();
  await expect(
    f.service.approve(permId, { ...input, previewSha256: preview.preview.sha256 }, f.actor),
  ).rejects.toThrow(/uncertain/);
  f.restartOwners();
  configureTelosSourcePermissionRecovery(createTelosSourcePermissionRecovery(() => f.dbPath));
  expect(getPendingRequestsBySession('planning')).toEqual([]);
  expect(getPendingRequestsBySession('planning', 'another-operator')).toEqual([]);
  expect(getPendingRequestsBySession('other-session', f.actor.id)).toEqual([]);
  const requests = getPendingRequestsBySession('planning', f.actor.id);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ permId, recoveryOnly: true, reviewKind: 'telos_source' });
  expect(requests[0].expiresAt).toBeUndefined();
  expect(JSON.stringify(requests[0])).not.toContain(message.blocks[0].content);
  expect(dismissTelosSourcePermissionRecovery(permId, 'planning', 'another-operator')).toBe(false);
  expect(dismissTelosSourcePermissionRecovery(permId, 'planning', f.actor.id)).toBe(true);
  expect(getPendingRequestsBySession('planning', f.actor.id)).toEqual([]);
  expect((await f.service.review(permId, 'planning', f.actor)).recovery?.preview).toEqual(
    preview.preview,
  );
  expect(f.counts().canonicalCreates).toBe(1);
  expect(f.counts().sources.total).toBe(1);
});
