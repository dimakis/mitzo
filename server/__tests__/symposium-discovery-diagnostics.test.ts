import { expect, it } from 'vitest';
import { classifyDiscoveryCommandFailure } from '../symposium-discovery-diagnostics.js';
it.each([
  [{ code: 'ENOENT' }, undefined, 'spawn-failed', 'not-started'],
  [{ code: 'EACCES' }, undefined, 'spawn-failed', 'not-started'],
  [{ code: 'ENOENT' }, 123, 'transport-or-process-failure', 'possibly-started'],
  [{ code: 1 }, 123, 'nonzero-exit', 'possibly-started'],
  [{ code: 'ETIMEDOUT' }, 123, 'timeout', 'possibly-started'],
  [{ killed: true, signal: 'SIGTERM' }, 123, 'timeout', 'possibly-started'],
  [{ code: 'ECONNRESET' }, 123, 'transport-or-process-failure', 'possibly-started'],
] as const)(
  'classifies process outcome without exposing errors %#',
  (error, pid, failureClass, commandDispatch) => {
    const result = classifyDiscoveryCommandFailure(
      { ...error, message: 'SECRET', stderr: 'TOKEN', cmd: 'PRIVATE' },
      pid,
    );
    expect(result.detail).toMatchObject({ failureClass, commandDispatch });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|TOKEN|PRIVATE/);
  },
);
