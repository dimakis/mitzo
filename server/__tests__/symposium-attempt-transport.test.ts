import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  confirmControlledAttemptStopped,
  controlledAttemptArgv,
  controllerClaimDigest,
  launchControlledAttempt,
  verifyControllerProof,
} from '../symposium-attempt-transport.js';

const sandbox = { sandboxName: 'symposium', workdir: '/sandbox/workspaces/mgmt' };
const claim = 'durable-claim';

function fakeProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

describe('claim-bound native controller transport', () => {
  it('pins run and cancel to the same digest without putting routed text in argv', () => {
    const run = controlledAttemptArgv('run', claim, 'read', [
      '/usr/bin/env',
      'KEY=value',
      'claude',
    ]);
    expect(run).toEqual([
      '/usr/local/bin/symposium-attempt-controller',
      'run',
      controllerClaimDigest(claim),
      'read',
      '/usr/bin/env',
      'KEY=value',
      'claude',
    ]);
    expect(controlledAttemptArgv('cancel', claim)).toEqual(
      run.slice(0, 1).concat('cancel', run[2]),
    );
    expect(() => controlledAttemptArgv('run', claim, 'write', ['bad\0arg'])).toThrow();
    expect(() =>
      launchControlledAttempt({ ...sandbox, workdir: '/sandbox' }, claim, 'read', ['true']),
    ).toThrow(/layout/);
  });

  it('launches a streaming SSH relay for the exact claim', () => {
    const child = fakeProcess();
    const mockSpawn = vi.fn(() => child) as unknown as typeof spawn;
    const attempt = launchControlledAttempt(sandbox, claim, 'read', ['/bin/cat'], mockSpawn);
    expect(attempt.child).toBe(child);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args, options] = vi.mocked(mockSpawn).mock.calls[0];
    expect(args?.join(' ')).toContain(controllerClaimDigest(claim));
    expect(args?.join(' ')).toContain('/bin/cat');
    expect(options?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('requires exact terminal proof; transport closure and other claims do not count', async () => {
    const child = fakeProcess();
    const mockSpawn = vi.fn(() => child) as unknown as typeof spawn;
    const pending = confirmControlledAttemptStopped(sandbox, claim, mockSpawn);
    child.stdout.write(
      JSON.stringify({
        claim: controllerClaimDigest('other'),
        terminal: true,
        exit_code: 0,
        signal: 0,
      }),
    );
    child.emit('close', 0);
    await expect(pending).rejects.toThrow(/unconfirmed/);
    expect(() => verifyControllerProof('{}', claim)).toThrow(/unconfirmed/);
  });

  it('confirms repeat cancellation from the exact terminal marker', async () => {
    const child = fakeProcess();
    const mockSpawn = vi.fn(() => child) as unknown as typeof spawn;
    const pending = confirmControlledAttemptStopped(sandbox, claim, mockSpawn);
    child.stdout.write(
      JSON.stringify({
        claim: controllerClaimDigest(claim),
        terminal: true,
        exit_code: -1,
        signal: 9,
      }) + '\n',
    );
    child.emit('close', 0);
    await expect(pending).resolves.toBeUndefined();
  });
});
