import { expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  ftruncateSync,
  closeSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  measureStagingDeploymentGrowth,
  assertStagingSnapshotAdmission,
} from '../../scripts/lib/staging-deployment-growth.mjs';

it('reserves full logical sparse-file copy size and metadata without following archive symlinks', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'snapshot-growth-')));
  try {
    mkdirSync(join(root, 'workspace'));
    mkdirSync(join(root, 'state'));
    const fd = openSync(join(root, 'state', 'sparse'), 'wx', 0o600);
    ftruncateSync(fd, 6 * 1024 ** 3);
    closeSync(fd);
    symlinkSync('/unknown/unrelated/tree', join(root, 'workspace', 'retained-link'));
    expect(measureStagingDeploymentGrowth(root)).toBeGreaterThan(6);
    const metrics = {
      pressureLevel: 1,
      memoryFreePercent: 45,
      swapUsedMiB: 0,
      diskFreeGiB: 40,
      stagingGiB: 40,
      vmMemoryMiB: 4096,
      vmCpus: 2,
    };
    expect(assertStagingSnapshotAdmission(root, () => metrics)).toBeGreaterThan(6);
    for (const changed of [{ stagingGiB: 42 }, { diskFreeGiB: 26 }])
      expect(() =>
        assertStagingSnapshotAdmission(root, () => ({ ...metrics, ...changed })),
      ).toThrow(/admission/);
    rmSync(join(root, 'state'), { recursive: true });
    expect(() => measureStagingDeploymentGrowth(root)).toThrow(/snapshot/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
