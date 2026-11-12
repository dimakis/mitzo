import { expect, it } from 'vitest';
import { ToolFailureSchema, toolFailure, toolFailureAction } from '../tool-failure.js';

it('preserves a known approval expiry as an unexecuted operation with explicit repair', () => {
  const failure = toolFailure('approval_expired', 'approval', 'not_started');
  expect(ToolFailureSchema.parse(failure)).toEqual({
    code: 'approval_expired',
    phase: 'approval',
    effectStatus: 'not_started',
    recovery: 'renew_approval',
  });
  expect(toolFailureAction(failure)).toMatch(/did not run/i);
});

it('requires reconciliation for unknown effects even when the original error is invalid input', () => {
  expect(toolFailure('invalid_input', 'cleanup', 'unknown').recovery).toBe('inspect_operation');
  expect(toolFailure('tool_timeout', 'execution', 'unknown').recovery).toBe('inspect_operation');
});

it('keeps cancellation, explicit denial and authentication distinct', () => {
  expect(toolFailure('cancelled', 'approval', 'not_started').recovery).toBe('none');
  expect(toolFailure('permission_denied', 'approval', 'not_started').recovery).toBe('none');
  expect(toolFailure('operator_authentication_required', 'admission', 'not_started').recovery).toBe(
    'reconnect',
  );
  expect(
    toolFailureAction(toolFailure('operator_authentication_required', 'execution', 'unknown')),
  ).toMatch(/original.*receipt/i);
});

it('rejects provider-selected recovery metadata and unknown fields', () => {
  expect(
    ToolFailureSchema.safeParse({
      code: 'tool_timeout',
      phase: 'execution',
      effectStatus: 'unknown',
      recovery: 'retry_automatically',
    }).success,
  ).toBe(false);
  expect(
    ToolFailureSchema.safeParse({
      ...toolFailure('cancelled', 'approval', 'not_started'),
      grant: true,
    }).success,
  ).toBe(false);
});
