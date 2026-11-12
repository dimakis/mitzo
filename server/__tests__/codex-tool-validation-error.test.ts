import { beforeEach, expect, it, vi } from 'vitest';
import { RuntimeFailureSchema } from '@mitzo/protocol';
import { reportCodexCredentialInvalidation } from '../codex-tool-validation-error.js';
import { SessionRuntimeError } from '../session-runtime-error.js';

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => diagnostics }));
beforeEach(() => vi.clearAllMocks());

it.each(['startup', 'throwing', 'invalid'] as const)(
  'preserves the primary credential error when its phase is %s',
  (phase) => {
    const original = Error('private credential cause');
    const publish = vi.fn();
    const isLive = vi.fn(() => {
      if (phase === 'throwing') throw Error('private phase cause');
      return phase === 'startup' ? false : 'true';
    }) as unknown as () => boolean;
    expect(reportCodexCredentialInvalidation(original, true, false, publish, isLive)).toBe(
      original,
    );
    expect(publish).not.toHaveBeenCalled();
    if (phase === 'throwing') {
      expect(diagnostics.warn).toHaveBeenCalledExactlyOnceWith(
        'Credential validation phase unavailable; preserving original failure',
        { stage: 'credential_check', code: 'validation_phase_unavailable' },
      );
      expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('private');
    } else expect(diagnostics.warn).not.toHaveBeenCalled();
  },
);

it('observes the current handoff phase rather than a phase captured during connection', () => {
  const original = Object.assign(Error('private credential cause'), { code: 'EPERM' });
  const publish = vi.fn();
  let live = false;
  const isLive = () => live;
  expect(reportCodexCredentialInvalidation(original, true, false, publish, isLive)).toBe(original);
  live = true;
  const failure = reportCodexCredentialInvalidation(original, true, false, publish, isLive);
  expect(failure).toBeInstanceOf(SessionRuntimeError);
  expect(failure).toMatchObject({ code: 'tool_validation_failed', cause: original });
  expect(publish).toHaveBeenCalledExactlyOnceWith(failure);
  const publicDiagnostic = RuntimeFailureSchema.parse((failure as SessionRuntimeError).telemetry());
  expect(JSON.stringify(publicDiagnostic)).not.toContain('private');
});

it('retains an existing reviewed failure without consulting the phase owner', () => {
  const original = new SessionRuntimeError('login_refresh_invalid');
  const publish = vi.fn();
  const isLive = vi.fn(() => {
    throw Error('Phase must not replace an existing diagnosis');
  });
  expect(
    reportCodexCredentialInvalidation(
      Error('wrapper', { cause: original }),
      true,
      false,
      publish,
      isLive,
    ),
  ).toBe(original);
  expect(isLive).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledExactlyOnceWith(original);
});

it('does not consult the phase owner or classify an initial login failure', () => {
  const original = Error('private startup cause');
  const publish = vi.fn();
  const isLive = vi.fn(() => true);
  expect(reportCodexCredentialInvalidation(original, false, false, publish, isLive)).toBe(original);
  expect(isLive).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});
