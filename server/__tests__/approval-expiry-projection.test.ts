import { expect, it } from 'vitest';
import { ApprovalExpiredError } from '@mitzo/harness';
import { codexToolFailureResult, withCodexToolCleanup } from '../codex-tool-failure.js';
import { taskExecutionFailure } from '../task-execution-failure.js';

it('reports an expired tool approval as renewable, not an uncertain execution', () => {
  const value = JSON.parse(codexToolFailureResult(new ApprovalExpiredError(), false).content);
  expect(value).toMatchObject({
    error: 'approval_expired',
    failure: {
      code: 'approval_expired',
      phase: 'approval',
      effectStatus: 'not_started',
      recovery: 'renew_approval',
    },
    retry: 'after_user_returns',
  });
  expect(value.message).toContain('Approval timed out');
});

it('keeps cleanup uncertainty separate from the approval timeout', async () => {
  let failure: unknown;
  try {
    await withCodexToolCleanup(async () => {
      throw new ApprovalExpiredError();
    }, [
      () => {
        throw Error('cleanup failed');
      },
    ]);
  } catch (error) {
    failure = error;
  }
  const value = JSON.parse(codexToolFailureResult(failure, false).content);
  expect(value.failure).toMatchObject({
    code: 'approval_expired',
    effectStatus: 'unknown',
    recovery: 'inspect_operation',
  });
  expect(value.diagnostic.primary).toMatchObject({
    reason: 'approval_expired',
    effectStatus: 'not_started',
  });
});

it('TaskExecution preserves approval expiry without reporting a user denial', () => {
  const value = taskExecutionFailure(new ApprovalExpiredError(), 'authorize', 'request', false);
  expect(value.failure).toMatchObject({
    code: 'approval_expired',
    phase: 'approval',
    effectStatus: 'not_started',
    recovery: 'renew_approval',
  });
  expect(value.recovery).toContain('fresh approval');
});
