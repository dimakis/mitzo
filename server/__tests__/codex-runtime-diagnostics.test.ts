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
it.each(['config/read', 'thread/turns/list'])('retains the known %s RPC method', (method) => {
  expect(codexRuntimeErrorTelemetry(new CodexRequestError(method, 'invalid_request'))).toEqual({
    requestMethod: method,
    requestErrorCategory: 'invalid_request',
  });
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

it('explains a failed resume with no matching native binding without inventing provider history', () => {
  const error = new Error('Codex conversation binding unavailable or changed');
  expect(codexRuntimeDiagnostic(error)).toBe(
    'This chat has no matching native conversation binding. Its saved messages are preserved. Inspect startup recovery before continuing.',
  );
  expect(codexRuntimeErrorTelemetry(error)).toEqual({ conversationBindingUnavailable: true });
  const upstream = new Error(error.message + ': Bearer sk-secret');
  expect(codexRuntimeDiagnostic(upstream)).toBeUndefined();
  expect(codexRuntimeErrorTelemetry(upstream)).toEqual({});
});
