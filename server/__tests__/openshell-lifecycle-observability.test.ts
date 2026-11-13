import { afterEach, expect, it, vi } from 'vitest';
import {
  OpenShellLifecycleObservability,
  openShellLifecycleObservabilityThresholds,
} from '../openshell-lifecycle-observability.js';

it('collects read-only Podman usage and reports unavailable collection', async () => {
  const run = vi
    .fn()
    .mockResolvedValue(
      JSON.stringify([
        { Type: 'Images', Total: 2, Active: 1, RawSize: '100B', RawReclaimable: '20B' },
      ]),
    );
  const o = new OpenShellLifecycleObservability({ run, log: { warn: vi.fn(), info: vi.fn() } });
  await expect(o.collect(new AbortController().signal)).resolves.toMatchObject({
    available: true,
    usageBytes: 100,
  });
  expect(run.mock.calls[0][0]).toBe('podman');
  expect(run.mock.calls[0][1]).toEqual(['system', 'df', '--format', 'json']);
  const bad = new OpenShellLifecycleObservability({
    run: vi.fn().mockRejectedValue(new Error('no podman')),
    log: { warn: vi.fn(), info: vi.fn() },
  });
  await expect(bad.collect(new AbortController().signal)).resolves.toMatchObject({
    available: false,
  });
  const malformed = new OpenShellLifecycleObservability({
    run: vi.fn().mockResolvedValue(JSON.stringify([{ RawSize: 'unknown' }])),
    log: { warn: vi.fn(), info: vi.fn() },
  });
  await expect(malformed.collect(new AbortController().signal)).resolves.toMatchObject({
    available: false,
  });
});

afterEach(() => vi.useRealTimers());

const validUsage = JSON.stringify([{ RawSize: 100, RawReclaimable: 20 }]);
const logger = () => ({ warn: vi.fn(), info: vi.fn() });

it.each([
  ['{secret invalid json', 'parse', 'invalid_json'],
  ['{}', 'validate', 'invalid_shape'],
  ['[]', 'validate', 'invalid_shape'],
  ['[null]', 'validate', 'invalid_shape'],
  [JSON.stringify([{ RawSize: 100 }]), 'validate', 'invalid_bytes'],
  [JSON.stringify([{ RawSize: 'unknown', RawReclaimable: 1 }]), 'validate', 'invalid_bytes'],
  [JSON.stringify([{ RawSize: {}, RawReclaimable: 1 }]), 'validate', 'invalid_bytes'],
  [JSON.stringify([{ RawSize: 1e100, RawReclaimable: 1 }]), 'validate', 'invalid_bytes'],
  [JSON.stringify([{ RawSize: -1, RawReclaimable: 1 }]), 'validate', 'invalid_bytes'],
  [
    JSON.stringify([
      { RawSize: Number.MAX_SAFE_INTEGER, RawReclaimable: 0 },
      { RawSize: 1, RawReclaimable: 0 },
    ]),
    'validate',
    'invalid_bytes',
  ],
])('keeps invalid usage unavailable with a safe %s diagnostic', async (output, stage, code) => {
  const log = logger();
  const o = new OpenShellLifecycleObservability({ run: vi.fn().mockResolvedValue(output), log });
  const metrics = await o.collect(new AbortController().signal);
  expect(metrics).toMatchObject({
    available: false,
    diagnostic: {
      operation: 'podman_system_df',
      stage,
      code,
      collectionId: expect.any(String),
      nextAction: expect.any(String),
    },
  });
  expect(metrics).not.toHaveProperty('usageBytes');
  expect(metrics).not.toHaveProperty('reclaimableBytes');
  o.observe(metrics);
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ diagnostic: metrics.diagnostic }),
    'OpenShell usage telemetry unavailable',
  );
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
});

it('propagates sanitized command causes, deduplicates matching failures, and reports changes and recovery', async () => {
  const log = logger();
  const run = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error('token=secret /private/path'), {
        code: 'ENOENT',
        stdout: 'secret',
        stderr: 'secret',
      }),
    )
    .mockRejectedValueOnce(Object.assign(new Error('different secret'), { code: 'ENOENT' }))
    .mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'EACCES' }))
    .mockResolvedValueOnce(validUsage)
    .mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'EACCES' }));
  const o = new OpenShellLifecycleObservability({ run, log });
  const first = await o.collect(new AbortController().signal);
  expect(first).toMatchObject({
    available: false,
    diagnostic: {
      operation: 'podman_system_df',
      stage: 'command',
      code: 'command_failed',
      cause: { name: 'Error', code: 'ENOENT' },
    },
  });
  o.observe(first);
  o.observe(await o.collect(new AbortController().signal));
  expect(log.warn).toHaveBeenCalledTimes(1);
  o.observe(await o.collect(new AbortController().signal));
  expect(log.warn).toHaveBeenCalledTimes(2);
  o.observe(await o.collect(new AbortController().signal));
  expect(log.info).toHaveBeenCalledWith({}, 'OpenShell usage telemetry recovered');
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({ usageBytes: 100, reclaimableBytes: 20 }),
    'OpenShell lifecycle telemetry',
  );
  o.observe(await o.collect(new AbortController().signal));
  expect(log.warn).toHaveBeenCalledTimes(3);
  expect(JSON.stringify([first, log.warn.mock.calls])).not.toMatch(/secret|private|stdout|stderr/);
});

it('does not relay arbitrary error names, codes, messages or nested causes', async () => {
  const o = new OpenShellLifecycleObservability({
    run: vi.fn().mockRejectedValue(
      Object.assign(new Error('secret'), {
        name: 'secret',
        code: 'secret',
        cause: new Error('secret'),
      }),
    ),
    log: logger(),
  });
  const metrics = await o.collect(new AbortController().signal);
  expect(metrics).toMatchObject({ diagnostic: { cause: { name: 'Error' } } });
  expect(JSON.stringify(metrics)).not.toContain('secret');
});

it('skips pre-cancelled collection and preserves availability on expected cancellation', async () => {
  const run = vi.fn();
  const log = logger();
  const o = new OpenShellLifecycleObservability({ run, log });
  o.observe({ available: true, usageBytes: 1, reclaimableBytes: 0 });
  const controller = new AbortController();
  controller.abort(new Error('private reason'));
  const metrics = await o.collect(controller.signal);
  expect(run).not.toHaveBeenCalled();
  expect(metrics).toMatchObject({
    available: false,
    diagnostic: { code: 'cancelled', stage: 'command' },
  });
  o.observe(metrics);
  o.observe({ available: true, usageBytes: 1, reclaimableBytes: 0 });
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalledWith({}, 'OpenShell usage telemetry recovered');
  expect(o.outcomes.telemetry_cancelled).toBe(1);
});

it('discards a result delivered after caller cancellation', async () => {
  const controller = new AbortController();
  const o = new OpenShellLifecycleObservability({
    run: async () => {
      controller.abort();
      return validUsage;
    },
    log: logger(),
  });
  await expect(o.collect(controller.signal)).resolves.toMatchObject({
    available: false,
    diagnostic: { code: 'cancelled' },
  });
});

it('bounds collection to ten seconds and distinguishes timeout from caller abort', async () => {
  vi.useFakeTimers();
  const run = vi.fn(
    (_command, _args, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('secret abort reason'), {
                name: 'AbortError',
                code: 'ABORT_ERR',
              }),
            ),
          { once: true },
        );
      }),
  );
  const log = logger();
  const o = new OpenShellLifecycleObservability({ run, log });
  const pending = o.collect(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10_000);
  const metrics = await pending;
  expect(metrics).toMatchObject({
    available: false,
    diagnostic: {
      stage: 'command',
      code: 'command_timeout',
      cause: { name: 'AbortError', code: 'ABORT_ERR' },
    },
  });
  o.observe(metrics);
  expect(log.warn).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const aborted = o.collect(controller.signal);
  controller.abort();
  const cancelled = await aborted;
  expect(cancelled).toMatchObject({ available: false, diagnostic: { code: 'cancelled' } });
  o.observe(cancelled);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves supported raw-byte units and legitimate zero counters', async () => {
  const o = new OpenShellLifecycleObservability({
    run: vi.fn().mockResolvedValue(
      JSON.stringify([
        { RawSize: '1KiB', RawReclaimable: '0B' },
        { RawSize: '2KB', RawReclaimable: 20 },
      ]),
    ),
    log: logger(),
  });
  await expect(o.collect(new AbortController().signal)).resolves.toEqual({
    available: true,
    usageBytes: 3072,
    reclaimableBytes: 20,
  });
});
it('deduplicates threshold alerts and emits recovery', () => {
  const log = { warn: vi.fn(), info: vi.fn() };
  const o = new OpenShellLifecycleObservability({ run: vi.fn(), log, usageThresholdBytes: 10 });
  o.recordOutcome('stopped');
  o.observe({ available: true, usageBytes: 11, phaseCounts: { Ready: 1 } });
  o.observe({ available: true, usageBytes: 12, phaseCounts: {} });
  o.observe({ available: true, usageBytes: 1, phaseCounts: {} });
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({ usageBytes: 11, sandboxCount: 1, outcomes: { stopped: 1 } }),
    'OpenShell lifecycle telemetry',
  );
  expect(log.info).toHaveBeenCalledWith(
    expect.objectContaining({ usageBytes: 1, sandboxCount: 0 }),
    'OpenShell usage threshold recovered',
  );
});

it('reports telemetry availability transitions without repeated unavailable warnings', () => {
  const log = { warn: vi.fn(), info: vi.fn() };
  const o = new OpenShellLifecycleObservability({ log });
  o.observe({ available: false });
  o.observe({ available: false });
  expect(log.warn).toHaveBeenCalledTimes(1);
  o.observe({ available: true, usageBytes: 0, reclaimableBytes: 0 });
  expect(log.info).toHaveBeenCalledWith({}, 'OpenShell usage telemetry recovered');
  o.observe({ available: false });
  expect(log.warn).toHaveBeenCalledTimes(2);
});

it('parses optional positive telemetry thresholds and rejects unsafe values', () => {
  expect(
    openShellLifecycleObservabilityThresholds({
      MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES: '1048576',
      MITZO_OPENSHELL_SANDBOX_THRESHOLD: '4',
    }),
  ).toEqual({ usageThresholdBytes: 1048576, sandboxThreshold: 4 });
  expect(openShellLifecycleObservabilityThresholds({})).toEqual({
    usageThresholdBytes: undefined,
    sandboxThreshold: undefined,
  });
  expect(() =>
    openShellLifecycleObservabilityThresholds({ MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES: '0' }),
  ).toThrow('Invalid OpenShell lifecycle usage bytes threshold');
});
