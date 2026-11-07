import { expect, it } from 'vitest';
import { SessionRuntimeError, findSessionRuntimeError } from '../session-runtime-error.js';
import {
  SESSION_RUNTIME_MESSAGES,
  RuntimeFailureSchema,
  runtimeFailureMessage,
  OrdinaryCodexRetainedCommandObservationSchema,
} from '@mitzo/protocol';

it('delivers every server runtime diagnostic through the strict public receipt contract', () => {
  for (const code of Object.keys(SESSION_RUNTIME_MESSAGES) as Array<
    keyof typeof SESSION_RUNTIME_MESSAGES
  >) {
    const failure = new SessionRuntimeError(code, { cause: Error('private credential path') });
    const observation = OrdinaryCodexRetainedCommandObservationSchema.parse({
      ok: false,
      code: 'retained_command',
      error: failure.publicMessage(),
      clientMsgId: 'original-command',
      sessionId: 'old-chat',
      state: 'reserved',
      runtimeFailure: failure.telemetry(),
    });
    expect(
      'runtimeFailure' in observation &&
        runtimeFailureMessage(RuntimeFailureSchema.parse(observation.runtimeFailure)),
    ).toBe(failure.publicMessage());
    expect(JSON.stringify(observation)).not.toContain('private credential path');
  }
  expect(
    RuntimeFailureSchema.safeParse({
      runtimeFailureCode: 'unreviewed_upstream_error',
      diagnosticId: '00000000-0000-4000-8000-000000000001',
    }).success,
  ).toBe(false);
});

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
