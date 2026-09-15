import { expect, it } from 'vitest';
import {
  OpenShellCapacityAdmission,
  OpenShellCapacityCollector,
  OpenShellCapacityError,
  openShellCapacityEnabled,
  openShellCapacityPolicy,
} from '../openshell-capacity.js';

const signal = () => new AbortController().signal;

it('keeps capacity admission behind an explicit rollout with an authoritative path', () => {
  expect(openShellCapacityEnabled({})).toBe(false);
  expect(openShellCapacityEnabled({ MITZO_OPENSHELL_CAPACITY_ENABLED: '0' })).toBe(false);
  expect(
    openShellCapacityEnabled(
      {
        MITZO_OPENSHELL_CAPACITY_ENABLED: '1',
        MITZO_OPENSHELL_CAPACITY_PATH: '/podman/storage',
      },
      () => undefined,
    ),
  ).toBe(true);
  expect(() => openShellCapacityEnabled({ MITZO_OPENSHELL_CAPACITY_ENABLED: '1' })).toThrow(
    'MITZO_OPENSHELL_CAPACITY_PATH',
  );
  expect(() => openShellCapacityEnabled({ MITZO_OPENSHELL_CAPACITY_ENABLED: 'yes' })).toThrow(
    'must be 0 or 1',
  );
  expect(() =>
    openShellCapacityEnabled(
      {
        MITZO_OPENSHELL_CAPACITY_ENABLED: '1',
        MITZO_OPENSHELL_CAPACITY_PATH: '/vm-only/path',
      },
      () => {
        throw new Error('missing');
      },
    ),
  ).toThrow('host-visible');
});

it('starts conservatively inside the hysteresis recovery band after a restart', async () => {
  const freePercents = [12, 16];
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => '[]',
    filesystem: async () => {
      const free = freePercents.shift()!;
      return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 10000 1 ${free * 100} 1% /`;
    },
  });
  const admission = new OpenShellCapacityAdmission(collector, openShellCapacityPolicy({}));
  await expect(admission.admitNewSandbox(signal())).rejects.toBeInstanceOf(OpenShellCapacityError);
  await expect(admission.admitNewSandbox(signal())).resolves.toBeUndefined();
});

it('keeps Podman usage/reclaimable separate from authoritative filesystem free capacity', async () => {
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => JSON.stringify([{ RawSize: '12.5MiB', RawReclaimable: '7KiB' }]),
    filesystem: async () =>
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 100 60 40 60% /',
  });
  await expect(collector.collect(signal())).resolves.toEqual({
    collectedAt: expect.any(Number),
    podman: { available: true, usageBytes: 12.5 * 1024 ** 2, reclaimableBytes: 7 * 1024 },
    filesystem: { available: true, totalBytes: 102400, freeBytes: 40960 },
  });
});

it('distinguishes SI and IEC units in fallback Podman metrics', async () => {
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () =>
      JSON.stringify([
        { Size: '12.5MB', Reclaimable: '7KB' },
        { Size: '2MiB', Reclaimable: '3KiB' },
      ]),
    filesystem: async () =>
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 100 60 40 60% /',
  });
  await expect(collector.collect(signal())).resolves.toMatchObject({
    podman: {
      available: true,
      usageBytes: 12.5 * 1000 ** 2 + 2 * 1024 ** 2,
      reclaimableBytes: 7 * 1000 + 3 * 1024,
    },
  });
});

it('propagates collection cancellation instead of converting it into capacity loss', async () => {
  const controller = new AbortController();
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => {
      controller.abort();
      return '[]';
    },
    filesystem: async () =>
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 100 60 40 60% /',
  });
  await expect(collector.collect(controller.signal)).rejects.toThrow(/abort/i);
});

it('does not misrepresent incomplete Podman metrics or a missing filesystem as zero', async () => {
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => JSON.stringify([{ Size: '12B' }]),
    filesystem: async () => 'not df output',
  });
  const result = await collector.collect(signal());
  expect(result.podman).toMatchObject({ available: false });
  expect(result.podman).not.toHaveProperty('usageBytes');
  expect(result.filesystem).toMatchObject({ available: false });
  expect(result.filesystem).not.toHaveProperty('freeBytes');
});

it('holds the hard admission circuit until the recovery threshold and serializes racing creates', async () => {
  const freePercents = [9, 12, 16, 50];
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => '[]',
    filesystem: async () => {
      const free = freePercents.shift() ?? 50;
      return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 10000 1 ${free * 100} 1% /`;
    },
  });
  const admission = new OpenShellCapacityAdmission(
    collector,
    openShellCapacityPolicy({
      MITZO_OPENSHELL_CAPACITY_WARNING_FREE_PERCENT: '20',
      MITZO_OPENSHELL_CAPACITY_HARD_FREE_PERCENT: '10',
      MITZO_OPENSHELL_CAPACITY_RECOVER_FREE_PERCENT: '15',
    }),
  );
  await expect(admission.admitNewSandbox(signal())).rejects.toBeInstanceOf(OpenShellCapacityError);
  await expect(admission.admitNewSandbox(signal())).rejects.toBeInstanceOf(OpenShellCapacityError);
  await expect(
    Promise.all([admission.admitNewSandbox(signal()), admission.admitNewSandbox(signal())]),
  ).resolves.toEqual([undefined, undefined]);
});

it('holds a successful capacity reservation until the physical create caller releases it', async () => {
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => '[]',
    filesystem: async () =>
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 10000 1 5000 1% /',
  });
  const admission = new OpenShellCapacityAdmission(collector, openShellCapacityPolicy({}));
  const releaseFirst = await admission.reserveNewSandbox(signal());
  let secondGranted = false;
  const second = admission.reserveNewSandbox(signal()).then((release) => {
    secondGranted = true;
    return release;
  });
  await Promise.resolve();
  expect(secondGranted).toBe(false);
  releaseFirst();
  const releaseSecond = await second;
  expect(secondGranted).toBe(true);
  releaseSecond();
});

it('cancels a queued reservation without letting later callers bypass the active holder', async () => {
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => '[]',
    filesystem: async () =>
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 10000 1 5000 1% /',
  });
  const admission = new OpenShellCapacityAdmission(collector, openShellCapacityPolicy({}));
  const releaseFirst = await admission.reserveNewSandbox(signal());
  const cancelled = new AbortController();
  const second = admission.reserveNewSandbox(cancelled.signal);
  cancelled.abort();
  await expect(second).rejects.toThrow(/abort/i);

  let thirdGranted = false;
  const third = admission.reserveNewSandbox(signal()).then((release) => {
    thirdGranted = true;
    return release;
  });
  await Promise.resolve();
  expect(thirdGranted).toBe(false);
  releaseFirst();
  const releaseThird = await third;
  expect(thirdGranted).toBe(true);
  releaseThird();
});

it('fails closed on collection loss and validates ordered hysteresis thresholds', async () => {
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => '[]',
    filesystem: async () => {
      throw new Error('/private/secret mount unavailable');
    },
  });
  const admission = new OpenShellCapacityAdmission(collector, openShellCapacityPolicy({}));
  await expect(admission.admitNewSandbox(signal())).rejects.toThrow('capacity is unavailable');
  expect(() =>
    openShellCapacityPolicy({
      MITZO_OPENSHELL_CAPACITY_WARNING_FREE_PERCENT: '10',
      MITZO_OPENSHELL_CAPACITY_HARD_FREE_PERCENT: '10',
    }),
  ).toThrow('thresholds');
  expect(() =>
    openShellCapacityPolicy({
      MITZO_OPENSHELL_CAPACITY_WARNING_FREE_PERCENT: '20',
      MITZO_OPENSHELL_CAPACITY_HARD_FREE_PERCENT: '10',
      MITZO_OPENSHELL_CAPACITY_RECOVER_FREE_PERCENT: '20',
    }),
  ).toThrow('thresholds');
});

it('does not use host root implicitly and status polling cannot mutate the admission latch', async () => {
  const missingPath = new OpenShellCapacityCollector(undefined, { podman: async () => '[]' });
  await expect(missingPath.collect(signal())).resolves.toMatchObject({
    filesystem: { available: false, error: expect.stringContaining('authoritative') },
  });

  const freePercents = [9, 50, 12, 16];
  const collector = new OpenShellCapacityCollector('/', {
    podman: async () => '[]',
    filesystem: async () => {
      const free = freePercents.shift() ?? 50;
      return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vm 10000 1 ${free * 100} 1% /`;
    },
  });
  const admission = new OpenShellCapacityAdmission(collector, openShellCapacityPolicy({}));
  await expect(admission.admitNewSandbox(signal())).rejects.toBeInstanceOf(OpenShellCapacityError);
  await expect(admission.status(signal())).resolves.toMatchObject({ state: 'hard_stop' });
  await expect(admission.admitNewSandbox(signal())).rejects.toBeInstanceOf(OpenShellCapacityError);
  await expect(admission.admitNewSandbox(signal())).resolves.toBeUndefined();
});
