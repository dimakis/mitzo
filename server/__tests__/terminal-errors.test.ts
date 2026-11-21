import { expect, it } from 'vitest';
import { TerminalOperationError, terminalFailureDiagnostic } from '../terminal-errors.js';

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
