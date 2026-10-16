import { describe, expect, it, vi } from 'vitest';
import * as permissions from '@mitzo/harness';

describe('host-owned Telos source permission identity', () => {
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
