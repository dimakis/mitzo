import { expect, it } from 'vitest';
import { partitionBrowserTests, requireBrowserPartitions } from '../ci-browser-partition.mjs';
import { requireBrowserPartitionEvidence } from '../ci-browser-partition.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planBrowserBatches } from '../ci-browser-batches.mjs';

const project = 'mobile-webkit';
const tests = [20, 19, 18, 3, 2, 1, 1].map((seconds, i) => ({
  id: `case-${i}`,
  project,
  selector: `[${project}] › file-${i}.spec.ts › case`,
  seconds,
}));
const discovery = { ended: true, status: 'passed', errors: 0, tests };
const weights = Object.fromEntries(tests.map((t) => [t.selector, t.seconds]));
const partitions = () =>
  [1, 2, 3, 4].map((index) => partitionBrowserTests(discovery, project, index, 4, weights));
it('balances durations deterministically with a complete exactly-once union', () => {
  const manifests = partitions();
  expect(() => requireBrowserPartitions(manifests, project, 4)).not.toThrow();
  expect(manifests.flatMap((m) => m.selection.tests.map((t) => t.id)).sort()).toEqual(
    tests.map((t) => t.id).sort(),
  );
  expect(manifests.map((m) => m.estimatedSeconds)).toEqual([20, 19, 18, 7]);
  expect(manifests).toEqual(
    [1, 2, 3, 4].map((i) =>
      partitionBrowserTests({ ...discovery, tests: [...tests].reverse() }, project, i, 4, weights),
    ),
  );
});
it.each(['missing', 'duplicate', 'foreign', 'drift', 'omitted'])(
  'fails closed for %s partition evidence',
  (change) => {
    const manifests = partitions();
    if (change === 'missing') manifests.pop();
    if (change === 'duplicate') manifests[1] = manifests[0];
    if (change === 'foreign') manifests[0].project = 'desktop-chromium';
    if (change === 'drift') manifests[0].inventory.pop();
    if (change === 'omitted') manifests[0].selection.tests.pop();
    expect(() => requireBrowserPartitions(manifests, project, 4)).toThrow();
  },
);
it('keeps differing project inventories, startup dependencies and new unmeasured cases', () => {
  const startup = { id: 'startup', project: 'browser-startup-0', selector: 'startup' };
  const full = { ...discovery, tests: [startup, ...tests] };
  const manifests = [1, 2, 3, 4].map((i) => partitionBrowserTests(full, project, i, 4, {}));
  expect(() => requireBrowserPartitions(manifests, project, 4)).not.toThrow();
  for (const manifest of manifests) expect(manifest.selection.tests).toContainEqual(startup);
  expect(() => partitionBrowserTests(discovery, project, 5, 4, weights)).toThrow();
  expect(() =>
    partitionBrowserTests({ ...discovery, ended: false }, project, 1, 4, weights),
  ).toThrow();
});
it('requires actual complete passing batch reports and refuses missing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-union-'));
  const write = (name: string, data: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(data));
  try {
    const manifest = partitionBrowserTests(discovery, project, 1, 1, weights);
    const batches = planBrowserBatches(manifest.selection, project);
    write('partition.json', manifest);
    write('summary.json', {
      selected: manifest.selection.tests.map((t) => t.id),
      batches: batches.map((b, i) => ({
        name: `batch-${String(i + 1).padStart(3, '0')}`,
        status: 'passed',
        tests: b.tests.map((t) => t.id),
      })),
    });
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const selected = [...batch.dependencies, ...batch.tests];
      write(`batch-${String(i + 1).padStart(3, '0')}.json`, {
        ended: true,
        status: 'passed',
        errors: 0,
        tests: selected,
        results: selected.map((t) => ({ id: t.id, status: 'passed', expectedStatus: 'passed' })),
      });
    }
    expect(() => requireBrowserPartitionEvidence([dir], project, 1)).not.toThrow();
    write('batch-001.json', {
      ended: true,
      status: 'passed',
      errors: 0,
      tests: batches[0].tests,
      results: [],
    });
    expect(() => requireBrowserPartitionEvidence([dir], project, 1)).toThrow();
    rmSync(join(dir, 'partition.json'));
    expect(() => requireBrowserPartitionEvidence([dir], project, 1)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
