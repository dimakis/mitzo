import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { probeOwnedArtifactAccess } from '../symposium-artifact-native-access.js';
import type { OpenShellRuntimeObservation } from '../openshell-runtime.js';
import { symposiumReconciliationFailureCode } from '../symposium-reconciliation-error.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const gateway = () => ({
  cli: '/private/cli',
  gateway: 'owned',
  workspace: 'work',
  managementEnvironment: {
    PATH: '/usr/bin:/bin',
    HOME: '/private/home',
    XDG_CONFIG_HOME: '/private/config',
    XDG_STATE_HOME: '/private/state',
    XDG_CACHE_HOME: '/private/cache',
  },
  verifyCustody: vi.fn(),
});
const identity = { id: 'sandbox-id', name: 'seat-name', workspace: 'work', phase: 'Ready' };
it('preserves custody failure internally and exposes only its fixed mount code', async () => {
  const g = gateway();
  const cause = new Error('PRIVATE_CUSTODY');
  g.verifyCustody.mockImplementationOnce(() => {
    throw cause;
  });
  const failure = await probeOwnedArtifactAccess(
    g as never,
    'seat-name',
    'sandbox-id',
    'script',
  ).catch((error) => error);
  expect(failure).toMatchObject({ message: 'SEAT_MOUNT_CUSTODY_FAILED', cause });
  expect(symposiumReconciliationFailureCode(failure)).toBe('SEAT_MOUNT_CUSTODY_FAILED');
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
  expect(execFile).not.toHaveBeenCalled();
});
it.each(['timeout', 'maxbuffer'] as const)(
  'distinguishes bounded native SSH %s without serializing private stderr or cause',
  async (kind) => {
    const cause = Object.assign(new Error('PRIVATE_TIMEOUT'), { killed: true, signal: 'SIGTERM' });
    if (kind === 'maxbuffer') Object.assign(cause, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    let step = 0;
    vi.mocked(execFile).mockImplementation(((
      _c: unknown,
      _a: unknown,
      _o: unknown,
      cb: (e: Error | null, out: string, err: string) => void,
    ) => {
      cb(step++ === 1 ? cause : null, JSON.stringify(identity), 'PRIVATE_STDERR');
    }) as never);
    const failure = await probeOwnedArtifactAccess(
      gateway() as never,
      'seat-name',
      'sandbox-id',
      'PRIVATE_SCRIPT',
    ).catch((error) => error);
    const code =
      kind === 'timeout' ? 'SEAT_MOUNT_NATIVE_TIMEOUT' : 'SEAT_MOUNT_NATIVE_ACCESS_FAILED';
    expect(failure).toMatchObject({
      code,
      message: code,
      cause,
    });
    expect(symposiumReconciliationFailureCode(failure)).toBe(code);
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    expect(execFile).toHaveBeenCalledTimes(2);
  },
);
it('uses native SSH resolution without numeric user override and checks identity before and after', async () => {
  const g = gateway();
  const outputs = [identity, { uid: 998, gid: 998 }, identity];
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => callback(null, JSON.stringify(outputs.shift()), '')) as never);
  await expect(
    probeOwnedArtifactAccess(g as never, 'seat-name', 'sandbox-id', '/usr/bin/id -u'),
  ).resolves.toEqual({ uid: 998, gid: 998 });
  expect(vi.mocked(execFile).mock.calls[1][0]).toBe('ssh');
  expect(vi.mocked(execFile).mock.calls[1][1]).toContain('sandbox@openshell-seat-name.work');
  expect(vi.mocked(execFile).mock.calls[1][1]).not.toContain('--user');
  expect(g.verifyCustody).toHaveBeenCalledTimes(4);
});
it.each([0, 2])('rejects changed immutable gateway identity at step %i', async (step) => {
  const outputs = [identity, { uid: 998, gid: 998 }, identity];
  outputs[step] = { ...identity, id: 'replacement' };
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => callback(null, JSON.stringify(outputs.shift()), '')) as never);
  await expect(
    probeOwnedArtifactAccess(gateway() as never, 'seat-name', 'sandbox-id', '/usr/bin/id -u'),
  ).rejects.toMatchObject({
    code: 'SEAT_MOUNT_NATIVE_IDENTITY_FAILED',
    cause: { message: 'Native artifact sandbox identity changed' },
  });
});
it('does not accept failed SSH as read-only evidence', async () => {
  let count = 0;
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    count++;
    callback(count === 2 ? new Error('private error') : null, JSON.stringify(identity), '');
  }) as never);
  await expect(
    probeOwnedArtifactAccess(gateway() as never, 'seat-name', 'sandbox-id', '/usr/bin/id -u'),
  ).rejects.toMatchObject({
    code: 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
    cause: { message: 'private error' },
  });
});
it.each([0, 1])(
  'retains distinct empty JSON observation at native step %i without changing failure',
  async (step) => {
    const events: OpenShellRuntimeObservation[] = [];
    const outputs = [
      JSON.stringify(identity),
      JSON.stringify({ uid: 998 }),
      JSON.stringify(identity),
    ];
    outputs[step] = '';
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, outputs.shift()!, 'PRIVATE_STDERR')) as never);
    await expect(
      probeOwnedArtifactAccess(
        gateway() as never,
        'seat-name',
        'sandbox-id',
        '/usr/bin/id -u',
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      code: step === 0 ? 'SEAT_MOUNT_NATIVE_IDENTITY_FAILED' : 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
      cause: { message: 'Unexpected end of JSON input' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'mount-json',
        operation: step === 0 ? 'native-identity' : 'native-ssh-probe',
        stage: 'parse-rejected',
        outputAvailable: true,
        outputBytes: 0,
        error: 'parse',
      }),
    );
    expect(JSON.stringify(events)).not.toContain('PRIVATE_STDERR');
  },
);
it.each([0, 1])(
  'observes finite native callback streams before strict JSON failure at %i',
  async (step) => {
    const events: OpenShellRuntimeObservation[] = [];
    let n = 0;
    const secret = 'PRIVATE_TOKEN_λ';
    vi.mocked(execFile).mockImplementation(((
      _c: string,
      _a: readonly string[],
      _o: unknown,
      cb: (e: Error | null, out: string, err: string) => void,
    ) => {
      const i = n++;
      cb(null, i === step ? '' : JSON.stringify(identity), i === step ? secret : '');
    }) as never);
    await expect(
      probeOwnedArtifactAccess(
        gateway() as never,
        'seat-name',
        'sandbox-id',
        'PRIVATE_SCRIPT',
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({
      code: step === 0 ? 'SEAT_MOUNT_NATIVE_IDENTITY_FAILED' : 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
      cause: { message: 'Unexpected end of JSON input' },
    });
    const operation = step === 0 ? 'native-identity' : 'native-ssh-probe';
    const terminal = events.findIndex(
      (e) => e.kind === 'native-command' && e.operation === operation,
    );
    const parse = events.findIndex(
      (e) => e.kind === 'mount-json' && e.operation === operation && e.stage === 'parse-rejected',
    );
    expect(terminal).toBeGreaterThan(-1);
    expect(terminal).toBeLessThan(parse);
    expect(events[terminal]).toEqual({
      kind: 'native-command',
      operation,
      stage: 'terminal',
      elapsedMs: expect.any(Number),
      exitCode: 0,
      signal: null,
      error: 'none',
      stdoutAvailable: true,
      stdoutBytes: 0,
      stderrAvailable: true,
      stderrBytes: Buffer.byteLength(secret),
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    expect(vi.mocked(execFile).mock.calls[step][2]).toEqual(
      expect.objectContaining({ timeout: 15000, maxBuffer: 16384, encoding: 'utf8' }),
    );
  },
);
it('observes nonzero native callback without retaining error text or changing rejection', async () => {
  const events: OpenShellRuntimeObservation[] = [];
  let n = 0;
  vi.mocked(execFile).mockImplementation(((
    _c: string,
    _a: readonly string[],
    _o: unknown,
    cb: (e: Error | null, out: string, err: string) => void,
  ) => {
    n++;
    cb(
      n === 2 ? Object.assign(new Error('PRIVATE_CAUSE'), { code: 7 }) : null,
      n === 2 ? '' : JSON.stringify(identity),
      'PRIVATE_STDERR',
    );
  }) as never);
  await expect(
    probeOwnedArtifactAccess(gateway() as never, 'seat-name', 'sandbox-id', 'PRIVATE_SCRIPT', (e) =>
      events.push(e),
    ),
  ).rejects.toMatchObject({
    code: 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
    cause: { message: 'PRIVATE_CAUSE', code: 7 },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'native-command',
      operation: 'native-ssh-probe',
      exitCode: 7,
      signal: null,
      error: 'nonzero',
      stdoutBytes: 0,
      stderrBytes: 14,
    }),
  );
  expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  expect(n).toBe(2);
});
it.each(['throw', 'reject'])(
  'native observation failure %s cannot change original result',
  async (mode) => {
    const outputs = [identity, { uid: 998, gid: 998 }, identity];
    vi.mocked(execFile).mockImplementation(((
      _c: string,
      _a: readonly string[],
      _o: unknown,
      cb: (e: Error | null, out: string, err: string) => void,
    ) => cb(null, JSON.stringify(outputs.shift()), '')) as never);
    const observer = () => {
      if (mode === 'throw') throw new Error('PRIVATE_OBSERVER');
      return Promise.reject(new Error('PRIVATE_OBSERVER'));
    };
    await expect(
      probeOwnedArtifactAccess(
        gateway() as never,
        'seat-name',
        'sandbox-id',
        'PRIVATE_SCRIPT',
        observer,
      ),
    ).resolves.toEqual({ uid: 998, gid: 998 });
    await Promise.resolve();
  },
);
