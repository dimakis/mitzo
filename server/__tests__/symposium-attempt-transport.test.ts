import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  confirmControlledAttemptStopped,
  controlledAttemptArgv,
  controlledAttemptRoute,
  controllerClaimDigest,
  launchControlledAttempt,
  verifyControllerProof,
} from '../symposium-attempt-transport.js';

const sandbox = {
  sandboxName: 'symposium',
  workdir: '/sandbox/workspaces/mgmt',
  cli: 'openshell',
  gateway: 'test-gateway',
  workspace: 'test-workspace',
  gatewayInsecure: false,
};
const claim = 'durable-claim';
afterEach(() => vi.unstubAllEnvs());

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
  it.each([undefined, 'https://127.0.0.1:8443'])(
    'pins launch and cancel routing despite conflicting ambient settings (%s)',
    async (gatewayEndpoint) => {
      for (const key of [
        'OPENSHELL_GATEWAY',
        'OPENSHELL_GATEWAY_ENDPOINT',
        'OPENSHELL_GATEWAY_INSECURE',
        'OPENSHELL_WORKSPACE',
      ])
        vi.stubEnv(key, 'wrong-ambient-value');
      const selected = {
        ...sandbox,
        cli: '/opt/openshell',
        gateway: 'personal',
        workspace: 'personal-only',
        gatewayEndpoint,
        gatewayInsecure: false,
      };
      const launchChild = fakeProcess();
      const launched = vi.fn(() => launchChild) as unknown as typeof spawn;
      launchControlledAttempt(selected, claim, 'write', ['/usr/bin/codex'], launched);
      const cancelChild = fakeProcess();
      const cancelled = vi.fn(() => cancelChild) as unknown as typeof spawn;
      const completion = confirmControlledAttemptStopped(selected, claim, cancelled);
      cancelChild.stdout.write(
        JSON.stringify({
          claim: controllerClaimDigest(claim),
          terminal: true,
          exit_code: 0,
          signal: 0,
        }),
      );
      cancelChild.emit('close', 0);
      await completion;
      for (const invocation of [
        vi.mocked(launched).mock.calls[0],
        vi.mocked(cancelled).mock.calls[0],
      ]) {
        const [, args, options] = invocation;
        const command = args!.join(' ');
        expect(command).toContain('/opt/openshell ssh-proxy');
        expect(command).toContain('--workspace personal-only');
        expect(command).toContain(
          gatewayEndpoint ? `--server '${gatewayEndpoint}'` : '--gateway-name personal',
        );
        expect(command).not.toContain('--gateway-insecure');
        expect(JSON.stringify(options?.env)).not.toContain('wrong-ambient-value');
      }
    },
  );

  it('refuses missing or malformed routing before spawning', () => {
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    expect(() =>
      launchControlledAttempt(
        { sandboxName: 'legacy', workdir: sandbox.workdir },
        claim,
        'write',
        ['/usr/bin/codex'],
        spawnProcess,
      ),
    ).toThrow('route is unavailable');
    expect(() => controlledAttemptRoute({ ...sandbox, gatewayInsecure: true })).toThrow(
      'explicit endpoint',
    );
    expect(() => controlledAttemptRoute({ ...sandbox, gateway: 42 } as never)).toThrow(
      'route is unavailable',
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
