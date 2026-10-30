import { expect, it } from 'vitest';
import { SessionRuntimeError, findSessionRuntimeError } from '../session-runtime-error.js';

it('preserves a reviewed recovery reason through runtime wrappers without exposing raw causes', () => {
  const original = new SessionRuntimeError('unsettled_effects', {
    cause: Error('secret-token private/path'),
  });
  const wrapped = new SessionRuntimeError('runtime_unavailable', {
    cause: Error('wrapper secret', { cause: original }),
  });
  const failure = findSessionRuntimeError(wrapped)!;
  expect(failure.code).toBe('unsettled_effects');
  expect(failure.message).toContain('Completed work will not be rerun');
  expect(JSON.stringify(failure.telemetry())).not.toContain('secret');
  expect(failure.publicMessage()).toContain(failure.diagnosticId);
  expect(failure.publicMessage()).not.toContain('private/path');
});

it('does not trust upstream text or structurally similar errors as reviewed diagnostics', () => {
  const forged = Object.assign(Error('secret'), { code: 'unsettled_effects' });
  expect(findSessionRuntimeError(forged)).toBeUndefined();
  const cyclic = Error('private');
  cyclic.cause = cyclic;
  expect(findSessionRuntimeError(cyclic)).toBeUndefined();
});
