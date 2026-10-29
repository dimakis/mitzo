import { expect, it } from 'vitest';
import { PendingHostTaskError } from '../pending-host-task.js';
import { CodexToolFailure, codexToolFailureResult } from '../codex-tool-failure.js';

it.each([
  ['EPERM', 'filesystem_denied'],
  ['EACCES', 'filesystem_denied'],
  ['ETIMEDOUT', 'deadline'],
  ['ENOSPC', 'storage_full'],
  ['PRIVATE', 'unknown'],
])('retains bounded %s cause while preserving uncertain effect status', (code, reason) => {
  const result = codexToolFailureResult(
    Object.assign(Error('SECRET /private/key'), { code }),
    false,
  );
  expect(JSON.parse(result.content)).toMatchObject({
    diagnostic: { stage: 'tool_execution', reason, effectStatus: 'unknown' },
  });
  expect(result.content).not.toContain('SECRET');
  expect(result.content).not.toContain('/private');
  expect(result.content).not.toContain('PRIVATE');
});

it('retains only explicitly typed pre-effect stage and cause', () => {
  const result = codexToolFailureResult(
    new CodexToolFailure('stale_owner', {
      stage: 'repository_preparation',
      reason: 'custody_changed',
      effectStatus: 'not_started',
    }),
    false,
  );
  expect(JSON.parse(result.content).diagnostic).toEqual({
    stage: 'repository_preparation',
    reason: 'custody_changed',
    effectStatus: 'not_started',
  });
});

it('preserves a bounded safe causal errno through wrapper errors and terminates cycles', () => {
  const cause = Object.assign(Error('SECRET filesystem'), { code: 'EPERM' });
  const wrapped = Error('SECRET wrapper', { cause: Error('outer', { cause }) });
  expect(JSON.parse(codexToolFailureResult(wrapped, false).content).diagnostic.reason).toBe(
    'filesystem_denied',
  );
  const cycle = Error('SECRET cyclic');
  cycle.cause = cycle;
  expect(JSON.parse(codexToolFailureResult(cycle, false).content).diagnostic.reason).toBe(
    'unknown',
  );
  let deep: Error = cause;
  for (let index = 0; index < 10; index++) deep = Error('SECRET depth', { cause: deep });
  expect(JSON.parse(codexToolFailureResult(deep, false).content).diagnostic.reason).toBe('unknown');
});

it.each([
  ['pending_host_task_ownership_changed', 'custody_changed'],
  ['pending_host_task_invalid_input', 'invalid_input'],
] as const)('retains known preparation boundary code %s through wrappers', (code, reason) => {
  const error = Error('SECRET wrapper', { cause: new PendingHostTaskError(code) });
  expect(JSON.parse(codexToolFailureResult(error, false).content).diagnostic.reason).toBe(reason);
});
