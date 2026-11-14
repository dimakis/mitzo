import { describe, expect, it } from 'vitest';
import type { StreamingBlock } from '../../types/chat';
import { getToolStatus, isApprovalTimeout } from '../tool-status';

const pending: StreamingBlock = {
  blockId: 'tool',
  blockType: 'tool_use',
  content: '',
  done: false,
  toolName: 'Bash',
};
it('recognizes an approval timeout without confusing a denied or executing operation', () => {
  const result = (code: string, effectStatus = 'not_started') => ({
    ...pending,
    toolError: true,
    toolResult: JSON.stringify({
      failure: {
        code,
        phase: 'approval',
        effectStatus,
        recovery: effectStatus === 'unknown' ? 'inspect_operation' : 'renew_approval',
      },
    }),
  });
  expect(isApprovalTimeout(result('approval_expired'))).toBe(true);
  expect(isApprovalTimeout(result('permission_denied'))).toBe(false);
  expect(isApprovalTimeout(result('approval_expired', 'unknown'))).toBe(false);
  expect(isApprovalTimeout({ ...pending, toolResult: 'not JSON' })).toBe(false);
});
describe('actual tool reply and interruption observations', () => {
  it.each([undefined, false])(
    'keeps unresolved tools running without an explicit true marker (%s)',
    (toolInterrupted) => {
      expect(getToolStatus({ ...pending, done: true, toolInterrupted })).toEqual({
        done: false,
        hasError: false,
        interrupted: false,
        running: true,
      });
    },
  );
  it.each([false, true])(
    'does not confuse provider block completion with a missing interrupted reply (%s)',
    (done) => {
      expect(
        getToolStatus({ ...pending, done, toolInterrupted: true, toolResultImages: [] }),
      ).toEqual({ done: false, hasError: false, interrupted: true, running: false });
    },
  );
  it.each([
    { toolResult: '', hasError: false },
    { toolResult: 'Real reply', hasError: false },
    { toolResult: 'Real failure', toolError: true, hasError: true },
    { toolResultImages: [{ id: 'real-image', mediaType: 'image/png' }], hasError: false },
  ])('lets an actual late reply override a retained marker: %j', ({ hasError, ...reply }) => {
    expect(getToolStatus({ ...pending, toolInterrupted: true, ...reply })).toEqual({
      done: true,
      hasError,
      interrupted: false,
      running: false,
    });
  });
});
