import { expect, it } from 'vitest';
import { CodexStartupError } from '../codex-startup-error.js';
import { CodexRequestError } from '../codex-app-server-client.js';
import { publicCodexStartupError } from '../codex-chat-session.js';
import { codexRuntimeErrorTelemetry } from '../codex-runtime-diagnostics.js';

it('identifies sandbox preparation failures without inventing queued work', () => {
  const cause = Object.assign(new Error('ssh PRIVATE_COMMAND: no space left. Bearer sk-secret'), {
    code: 'ENOSPC',
  });
  const error = new CodexStartupError('sandbox_preparation', cause);
  const message = publicCodexStartupError(error);
  expect(message).toContain('sandbox preparation');
  expect(message).toContain('storage is full');
  expect(message).toContain(error.diagnosticId);
  expect(message).not.toMatch(/queued work|migration|sk-secret|PRIVATE_COMMAND/);
  expect(codexRuntimeErrorTelemetry(error)).toEqual({
    startupPhase: 'sandbox_preparation',
    diagnosticId: error.diagnosticId,
    startupErrorCode: 'ENOSPC',
  });
  expect(error.cause).toBe(cause);
});

it('logs a bounded application source location without the stack or private path', () => {
  const cause = new Error('PRIVATE_COMMAND');
  cause.stack =
    'Error: PRIVATE_COMMAND\n    at run (/private/sk-secret/dist/openshell-runtime.js:321:12)\n    at unknown (/private/sk-secret/other.js:1:2)';
  const error = new CodexStartupError('sandbox_preparation', cause);
  const telemetry = codexRuntimeErrorTelemetry(error);
  expect(telemetry).toMatchObject({ startupErrorLocation: 'openshell-runtime:321:12' });
  expect(JSON.stringify(telemetry)).not.toMatch(/PRIVATE_COMMAND|sk-secret|private|other/);
});

it('retains command exit status without logging the command or stderr', () => {
  const cause = Object.assign(new Error('PRIVATE_COMMAND'), {
    cmd: 'ssh sk-secret',
    code: 1,
    signal: 'SIGTERM',
    stderr: 'Bearer sk-secret',
  });
  const telemetry = codexRuntimeErrorTelemetry(new CodexStartupError('sandbox_preparation', cause));
  expect(telemetry).toMatchObject({ startupExitCode: 1, startupSignal: 'SIGTERM' });
  expect(JSON.stringify(telemetry)).not.toMatch(/PRIVATE_COMMAND|sk-secret|stderr|ssh/);
});

it('preserves typed account diagnostics and their RPC details inside a startup phase', () => {
  const error = new CodexStartupError(
    'conversation_initialization',
    new CodexRequestError('thread/start', 'authentication', 401),
  );
  expect(publicCodexStartupError(error)).toMatch(/credentials or permissions/);
  expect(publicCodexStartupError(error)).toContain('conversation initialization');
  expect(codexRuntimeErrorTelemetry(error)).toEqual({
    startupPhase: 'conversation_initialization',
    diagnosticId: error.diagnosticId,
    requestMethod: 'thread/start',
    requestErrorCategory: 'authentication',
    requestErrorCode: 401,
  });
});

it.each(['Bearer sk-secret', { message: 'PRIVATE_COMMAND', code: 'sk-secret' }])(
  'keeps arbitrary thrown values and codes out of public diagnostics and logs',
  (cause) => {
    const error = new CodexStartupError('context_preparation', cause);
    const output = JSON.stringify({
      message: publicCodexStartupError(error),
      telemetry: codexRuntimeErrorTelemetry(error),
    });
    expect(output).toContain('context_preparation');
    expect(output).toContain(error.diagnosticId);
    expect(output).not.toMatch(/sk-secret|PRIVATE_COMMAND|queued work/);
  },
);

it('does not tell users to inspect a queue for an unclassified startup failure', () => {
  expect(publicCodexStartupError(new Error('unknown startup failure'))).not.toMatch(
    /queue|recovery/,
  );
});

it.each([
  ['ENOSPC', 'storage is full'],
  ['EACCES', 'could not access a required file'],
  ['ECONNREFUSED', 'not accepting connections'],
])('explains a first-send %s failure while preserving uncertain-work advice', (code, reason) => {
  const cause = Object.assign(new Error('PRIVATE_COMMAND Bearer sk-secret'), { code });
  const error = new CodexStartupError('initial_turn_dispatch', cause);
  expect(publicCodexStartupError(error)).toContain(reason);
  expect(publicCodexStartupError(error)).toMatch(/outcome may be unknown; inspect saved work/);
  expect(publicCodexStartupError(error)).not.toMatch(/PRIVATE_COMMAND|sk-secret/);
});

it('keeps the resource reason when first send wraps an existing runtime failure', () => {
  const cause = Object.assign(new Error('PRIVATE_COMMAND'), { code: 'ENOSPC' });
  const error = new CodexStartupError(
    'initial_turn_dispatch',
    new CodexStartupError('runtime_connection', cause),
  );
  expect(publicCodexStartupError(error)).toContain('storage is full');
  expect(publicCodexStartupError(error)).toMatch(/inspect saved work/);
  expect(codexRuntimeErrorTelemetry(error)).toMatchObject({
    startupPhase: 'initial_turn_dispatch',
    startupErrorCode: 'ENOSPC',
    diagnosticId: error.diagnosticId,
  });
});
