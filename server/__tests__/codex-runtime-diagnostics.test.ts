import { expect, it } from 'vitest';
import { CodexRequestError, CodexTransportError } from '../codex-app-server-client.js';
import {
  codexRuntimeDiagnostic,
  codexRuntimeErrorTelemetry,
} from '../codex-runtime-diagnostics.js';

it.each([
  ['authentication', /credentials or permissions/],
  ['rate_limit', /usage or rate limit/],
  ['context_limit', /context is too large/],
  ['invalid_request', /configuration/],
  ['routing_missing_workspace', /workspace routing/],
] as const)('explains a sanitized %s request failure', (category, message) => {
  const error = new CodexRequestError('thread/start', category, -32600);
  expect(codexRuntimeDiagnostic(error)).toMatch(message);
  expect(codexRuntimeErrorTelemetry(error)).toEqual({
    requestMethod: 'thread/start',
    requestErrorCategory: category,
    requestErrorCode: -32600,
  });
});

it('retains safe transport failure classes', () => {
  const error = new CodexTransportError('timeout');
  expect(codexRuntimeDiagnostic(error)).toMatch(/timed out/);
  expect(codexRuntimeErrorTelemetry(error)).toEqual({ transportErrorCategory: 'timeout' });
});

it('does not relay unknown exceptions or arbitrary request methods', () => {
  const secret = 'Bearer sk-secret https://private.example';
  expect(codexRuntimeDiagnostic(new Error(secret))).toBeUndefined();
  expect(codexRuntimeErrorTelemetry(new Error(secret))).toEqual({});
  const error = new CodexRequestError(secret, 'unknown');
  expect(codexRuntimeDiagnostic(error)).toMatch(/configuration/);
  expect(codexRuntimeErrorTelemetry(error)).toEqual({ requestErrorCategory: 'unknown' });
  expect(JSON.stringify(codexRuntimeErrorTelemetry(error))).not.toContain(secret);
});
