import { expect, it, vi } from 'vitest';
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
  await expect(bad.collect(new AbortController().signal)).resolves.toEqual({ available: false });
  const malformed = new OpenShellLifecycleObservability({
    run: vi.fn().mockResolvedValue(JSON.stringify([{ RawSize: 'unknown' }])),
    log: { warn: vi.fn(), info: vi.fn() },
  });
  await expect(malformed.collect(new AbortController().signal)).resolves.toEqual({
    available: false,
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
