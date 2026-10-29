import { expect, it } from 'vitest';
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
