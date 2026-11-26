import { expect, it } from 'vitest';
import {
  TerminalOperationError,
  sanitizedProcessCause,
  terminalFailureDiagnostic,
} from '../terminal-errors.js';

it.each(['EPERM', 'ENOENT', 'EACCES', 'EMFILE', 'ETIMEDOUT'])(
  'retains the safe %s cause through the service boundary without transport secrets',
  (code) => {
    const cause = Object.assign(new Error('ssh --token private-secret /private/path'), {
      code,
      stderr: 'private stderr',
    });
    const error = new TerminalOperationError('terminal_start_failed', cause);
    expect(error.cause).toBe(cause);
    expect(terminalFailureDiagnostic(error)).toEqual({
      code: 'terminal_start_failed',
      stage: 'start',
      causes: ['terminal_start_failed', code],
    });
    expect(JSON.stringify(terminalFailureDiagnostic(error))).not.toContain('private');
  },
);
it('identifies the native PTY failure without serializing process arguments or arbitrary error codes', () => {
  const error = new TerminalOperationError(
    'terminal_start_failed',
    new Error('posix_spawnp failed.'),
  );
  expect(terminalFailureDiagnostic(error).causes).toEqual([
    'terminal_start_failed',
    'pty_spawn_failed',
  ]);
  const secretCode = Object.assign(new Error('private'), { code: 'private-token' });
  expect(
    terminalFailureDiagnostic(new TerminalOperationError('terminal_open_failed', secretCode))
      .causes,
  ).toEqual(['terminal_open_failed', 'unclassified_error']);
});
it('drops transport secrets from retained process causes while keeping the diagnostic code', () => {
  const processError = Object.assign(
    new Error('Command failed: ssh -o ProxyCommand=grant-secret'),
    {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
      cmd: 'ssh -o ProxyCommand=grant-secret',
      stderr: 'grant-secret stderr',
      stdout: 'grant-secret stdout',
    },
  );
  const cause = sanitizedProcessCause(processError);
  expect(cause).toMatchObject({ code: 'ETIMEDOUT', signal: 'SIGTERM' });
  expect(cause.cause).toBeUndefined();
  const serialized = JSON.stringify({ ...cause, message: cause.message, stack: cause.stack });
  expect(serialized).not.toContain('grant-secret');
  const wrapped = new TerminalOperationError(
    'terminal_open_failed',
    Error('Terminal transport unavailable', { cause }),
  );
  expect(terminalFailureDiagnostic(wrapped).causes).toEqual([
    'terminal_open_failed',
    'unclassified_error',
    'ETIMEDOUT',
  ]);
  expect(sanitizedProcessCause(Object.assign(new Error('x'), { code: 255 }))).toMatchObject({
    code: 255,
  });
});
