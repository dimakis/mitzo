import { execFile } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellLifecycleObservability } from '../openshell-lifecycle-observability.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

// Exercise the owning subprocess adapter through the same collect -> observe
// consumer path used by index.ts. No Podman process or live runtime is launched.
it('delivers bounded subprocess failures to the structured logger and then recovers', async () => {
  const log = { warn: vi.fn(), info: vi.fn() };
  vi.mocked(execFile)
    .mockImplementationOnce(((
      _cmd: unknown,
      _args: unknown,
      _options: unknown,
      done: (error: Error, stdout: string) => void,
    ) => {
      done(
        Object.assign(new Error('secret command output'), {
          code: 125,
          signal: 'SIGTERM',
          stderr: 'private',
        }),
        'private',
      );
    }) as typeof execFile)
    .mockImplementationOnce(((
      _cmd: unknown,
      _args: unknown,
      _options: unknown,
      done: (error: null, stdout: string) => void,
    ) => {
      done(null, JSON.stringify([{ RawSize: 50, RawReclaimable: 0 }]));
    }) as typeof execFile);
  const o = new OpenShellLifecycleObservability({ log });
  const failure = await o.collect(new AbortController().signal);
  o.observe(failure);
  expect(execFile).toHaveBeenCalledWith(
    'podman',
    ['system', 'df', '--format', 'json'],
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }),
    expect.any(Function),
  );
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      diagnostic: expect.objectContaining({
        operation: 'podman_system_df',
        stage: 'command',
        code: 'command_failed',
        cause: { name: 'Error', exitCode: 125, signal: 'SIGTERM' },
        nextAction: expect.any(String),
      }),
    }),
    'OpenShell usage telemetry unavailable',
  );
  expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret|private|stderr/);
  o.observe(await o.collect(new AbortController().signal));
  expect(log.info).toHaveBeenCalledWith({}, 'OpenShell usage telemetry recovered');
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({ usageBytes: 50, reclaimableBytes: 0 }),
    'OpenShell lifecycle telemetry',
  );
});

it('aborts the production subprocess signal on its bounded deadline', async () => {
  vi.useFakeTimers();
  vi.mocked(execFile).mockImplementationOnce(((
    _cmd: unknown,
    _args: unknown,
    options: { signal: AbortSignal },
    done: (error: Error, stdout: string) => void,
  ) => {
    options.signal.addEventListener(
      'abort',
      () =>
        done(Object.assign(new Error('private'), { name: 'AbortError', code: 'ABORT_ERR' }), ''),
      { once: true },
    );
  }) as typeof execFile);
  const log = { warn: vi.fn(), info: vi.fn() };
  const o = new OpenShellLifecycleObservability({ log });
  const pending = o.collect(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10_000);
  o.observe(await pending);
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'command_timeout' }) }),
    'OpenShell usage telemetry unavailable',
  );
  expect(vi.getTimerCount()).toBe(0);
});
