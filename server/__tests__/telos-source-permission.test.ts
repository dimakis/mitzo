import { describe, expect, it, vi } from 'vitest';
import * as permissions from '@mitzo/harness';

describe('host-owned Telos source permission identity', () => {
  it('dismisses an expired but still-live reviewed save without requesting a fresh duplicate approval', () => {
    const resolve = vi.fn();
    const permId = 'expired-reviewed-dismiss';
    const input = { summary: 'Already reviewed' };
    const now = Date.now();
    permissions.registerPending(
      permId,
      'TelosCreateOutcome',
      resolve,
      input,
      'unknown',
      'origin',
      {
        permId,
        sessionId: 'origin',
        toolName: 'TelosCreateOutcome',
        toolInput: JSON.stringify(input),
        reviewKind: 'telos_source',
        expiresAt: now + 10000,
      },
      { toolUseId: 'actual-expired-call' },
    );
    const proof = permissions.getPendingTelosSourceReview(permId, 'origin')!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10001);
    try {
      expect.soft(permissions.dismissReviewedTelosSourcePermission(proof)).toBe(true);
      expect(permissions.getPendingSessionId(permId)).toBeUndefined();
      expect.soft(resolve).toHaveBeenCalledWith({
        behavior: 'deny',
        message: expect.stringMatching(/retained.*recoverable/),
      });
      expect.soft(JSON.stringify(resolve.mock.calls)).not.toContain('request approval again');
    } finally {
      clock.mockRestore();
      permissions.removePending(permId);
    }
  });

  it.each(['toolUseId', 'toolName', 'toolInput', 'sessionId'] as const)(
    'does not dismiss a replacement live invocation with changed %s',
    (field) => {
      const resolve = vi.fn();
      const permId = 'replacement-reviewed-dismiss-' + field;
      const input = { summary: 'Already reviewed' };
      const request = {
        permId,
        sessionId: 'origin',
        toolName: 'TelosCreateOutcome',
        toolInput: JSON.stringify(input),
        reviewKind: 'telos_source' as const,
        expiresAt: Date.now() + 10000,
      };
      permissions.registerPending(
        permId,
        'TelosCreateOutcome',
        resolve,
        input,
        'unknown',
        'origin',
        request,
        { toolUseId: 'original-call' },
      );
      const proof = permissions.getPendingTelosSourceReview(permId, 'origin')!;
      const changed = {
        ...proof,
        [field]: field === 'toolInput' ? { summary: 'Replacement proposal' } : 'replacement',
      };
      permissions.registerPending(
        permId,
        changed.toolName,
        resolve,
        changed.toolInput,
        'unknown',
        changed.sessionId,
        { ...request, sessionId: changed.sessionId },
        { toolUseId: changed.toolUseId },
      );
      try {
        expect(permissions.dismissReviewedTelosSourcePermission(proof)).toBe(false);
        expect(resolve).not.toHaveBeenCalled();
        expect(permissions.getPendingSessionId(permId)).toBe(changed.sessionId);
      } finally {
        permissions.removePending(permId);
      }
    },
  );

  it('refuses generic allowances and resolves only the exact live invocation after durable approval', () => {
    const resolve = vi.fn();
    const input = { summary: 'Approved proposal' };
    permissions.registerPending(
      'source-review',
      'TelosCreateOutcome',
      resolve,
      input,
      'unknown',
      'origin',
      {
        permId: 'source-review',
        sessionId: 'origin',
        toolName: 'TelosCreateOutcome',
        toolInput: JSON.stringify(input),
        reviewKind: 'telos_source',
        expiresAt: Date.now() + 10000,
      },
      { toolUseId: 'actual-tool-call' },
    );
    expect(permissions.resolvePending('source-review', 'always', undefined, 'origin')).toBe(false);
    expect(permissions.resolvePending('source-review', 'once', undefined, 'origin')).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(permissions.getPendingTelosSourceReview('source-review', 'other')).toBeUndefined();
    const pending = permissions.getPendingTelosSourceReview('source-review', 'origin')!;
    expect(pending.toolUseId).toBe('actual-tool-call');
    expect(
      permissions.resolveReviewedTelosSourcePermission(
        pending,
        '00000000-0000-4000-8000-000000000001',
      ),
    ).toBe(true);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'allow',
        updatedInput: { ...input, __mitzoTelosApproval: '00000000-0000-4000-8000-000000000001' },
      }),
    );
    expect(permissions.getPendingTelosSourceReview('source-review', 'origin')).toBeUndefined();
  });
});
