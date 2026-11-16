import { expect, it, vi } from 'vitest';
import { SessionRuntimeError, findSessionRuntimeError } from '../session-runtime-error.js';
import {
  annotateAuthorityFailure,
  recordRuntimeFailure,
  runtimeFailureDiagnostics,
  retainedRuntimeFailure,
  retainRuntimeFailure,
} from '../runtime-failure-diagnostics.js';
import type { Span } from '@opentelemetry/api';
import * as logging from '../logger.js';

it('bounds internal retention while keeping non-Error causes and sink failures under the original reference', () => {
  const cause = { private: 'original non-Error payload' };
  const diagnosticCause = new Error('private sink failure');
  retainRuntimeFailure('evicted-reference', cause, () => {});
  for (let index = 0; index < 32; index++) {
    retainRuntimeFailure(`retention-${index}`, cause, () => {
      throw diagnosticCause;
    });
  }
  expect(retainedRuntimeFailure('evicted-reference')).toBeUndefined();
  expect(retainedRuntimeFailure('retention-0')?.cause).toBe(cause);
  expect(retainedRuntimeFailure('retention-31')?.diagnosticCause).toBe(diagnosticCause);
  const replacement = new Error('replacement');
  retainRuntimeFailure('retention-0', replacement, () => {});
  expect(retainedRuntimeFailure('retention-0')).toEqual({ cause: replacement });
  expect(retainedRuntimeFailure('retention-1')?.cause).toBe(cause);
});

it('preserves the original cause and emits only allowlisted diagnostics through wrappers', () => {
  const secret = Object.assign(new Error('token=synthetic-secret /private/account'), {
    code: 'EPERM',
  });
  const annotated = annotateAuthorityFailure(secret, 'workspace.root_identity');
  expect(annotated).toBe(secret);
  const wrapper = annotateAuthorityFailure(
    new Error('selection unavailable', { cause: annotated }),
    'selection.workspace',
  );
  const failure = new SessionRuntimeError('input_not_dispatched', { cause: wrapper });
  expect(runtimeFailureDiagnostics(failure)).toEqual({
    authorityChecks: ['selection.workspace', 'workspace.root_identity'],
    failedCheck: 'workspace.root_identity',
    causeType: 'Error',
    causeCode: 'EPERM',
  });
  expect(JSON.stringify(runtimeFailureDiagnostics(failure))).not.toMatch(
    /synthetic-secret|private\/account/,
  );
  expect(failure.cause).toBe(wrapper);
  expect(wrapper.cause).toBe(secret);
});

it('retains reviewed authentication classification and tolerates cyclic/non-Error causes', () => {
  const original = new SessionRuntimeError('auth_revoked');
  expect(annotateAuthorityFailure(original, 'owner.operator')).toBe(original);
  expect(findSessionRuntimeError(original)).toBe(original);
  original.cause = original;
  expect(runtimeFailureDiagnostics(original).failedCheck).toBe('owner.operator');
  const object = { code: 'EPERM', message: 'synthetic-secret' };
  expect(annotateAuthorityFailure(object, 'authority.owner').cause).toBe(object);
  expect(runtimeFailureDiagnostics(object)).toEqual({ causeType: 'unknown' });
  const untrusted = Object.assign(new Error('synthetic-secret'), { code: 'synthetic-secret' });
  expect(runtimeFailureDiagnostics(untrusted)).toEqual({ causeType: 'Error' });
});

it('marks a handled failure with the same diagnostic ID and sanitized trace attributes', () => {
  const failure = new SessionRuntimeError('input_not_dispatched', {
    cause: annotateAuthorityFailure(new Error('synthetic-secret'), 'selection.session_mode'),
  });
  const span = { setAttributes: vi.fn(), addEvent: vi.fn(), setStatus: vi.fn() };
  recordRuntimeFailure(span as unknown as Span, failure);
  expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'input_not_dispatched' });
  expect(span.setAttributes).toHaveBeenCalledWith(
    expect.objectContaining({
      'runtime.diagnostic_id': failure.diagnosticId,
      'runtime.failed_check': 'selection.session_mode',
    }),
  );
  expect(JSON.stringify(span.addEvent.mock.calls)).not.toContain('synthetic-secret');
});
it('keeps trace failure secondary to the runtime failure and reports it without private text', () => {
  const failure = new SessionRuntimeError('input_not_dispatched');
  const warn = vi.fn();
  const logger = vi
    .spyOn(logging, 'createLogger')
    .mockReturnValue({ warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() });
  try {
    const span = {
      setAttributes() {
        throw new Error('private-exporter-detail');
      },
    };
    expect(() => recordRuntimeFailure(span as unknown as Span, failure)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Runtime failure trace unavailable',
      expect.objectContaining({
        code: 'runtime_failure_trace_unavailable',
        diagnosticId: failure.diagnosticId,
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-exporter-detail');
  } finally {
    logger.mockRestore();
  }
});
