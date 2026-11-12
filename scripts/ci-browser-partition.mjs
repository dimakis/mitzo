import { planBrowserBatches, requireBrowserBatch } from './ci-browser-batches.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const ids = (values) => values.map((t) => t.id).sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Longest-first assignment within one complete project; no engine substitution. */
export function partitionBrowserTests(report, project, index, count, weights = {}) {
  const validated = planBrowserBatches(report, project).flatMap((batch) => batch.tests);
  if (
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(index) ||
    count < 1 ||
    index < 1 ||
    index > count
  )
    throw Error('Invalid browser partition');
  const inventory = [...validated].sort(
    (a, b) => a.selector.localeCompare(b.selector) || a.id.localeCompare(b.id),
  );
  const weight = (test) => {
    const value = weights[test.selector];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0))
      throw Error('Invalid browser duration weight');
    return value ?? 10; // New cases remain required, with a finite conservative weight.
  };
  const bins = Array.from({ length: count }, () => ({ tests: [], seconds: 0 }));
  for (const test of [...inventory].sort(
    (a, b) =>
      weight(b) - weight(a) || a.selector.localeCompare(b.selector) || a.id.localeCompare(b.id),
  )) {
    const bin = bins.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best));
    bin.tests.push(test);
    bin.seconds += weight(test);
  }
  const dependencies = report.tests
    .filter((t) => t.project.startsWith('browser-startup-'))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    project,
    index,
    count,
    inventory,
    estimatedSeconds: bins[index - 1].seconds,
    selection: { ...report, tests: [...dependencies, ...bins[index - 1].tests] },
  };
}

export function requireBrowserPartitions(manifests, project, count) {
  if (manifests.length !== count || new Set(manifests.map((m) => m.index)).size !== count)
    throw Error('Missing or duplicated browser partitions');
  const expected = manifests[0].inventory;
  const selected = [];
  const dependencies = manifests[0].selection.tests.filter((t) =>
    t.project.startsWith('browser-startup-'),
  );
  for (const m of manifests) {
    if (
      m.project !== project ||
      m.count !== count ||
      m.index < 1 ||
      m.index > count ||
      !Number.isSafeInteger(m.index) ||
      !equal(m.inventory, expected) ||
      !equal(
        m.selection.tests.filter((t) => t.project.startsWith('browser-startup-')),
        dependencies,
      )
    )
      throw Error('Browser partition inventory drift');
    selected.push(...planBrowserBatches(m.selection, project).flatMap((b) => b.tests));
  }
  if (
    new Set(ids(selected)).size !== selected.length ||
    !equal(ids(selected), ids(expected)) ||
    selected.some((t) => !expected.some((e) => equal(e, t)))
  )
    throw Error('Browser inventory must be covered exactly once');
}

/** Validate actual per-batch reports as well as the cross-shard inventory. */
export function requireBrowserPartitionEvidence(directories, project, count) {
  const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const manifests = directories.map((dir) => read(dir, 'partition.json'));
  requireBrowserPartitions(manifests, project, count);
  for (let i = 0; i < manifests.length; i++) {
    const batches = planBrowserBatches(manifests[i].selection, project);
    const summary = read(directories[i], 'summary.json');
    if (
      !equal(
        summary.selected,
        manifests[i].selection.tests.filter((t) => t.project === project).map((t) => t.id),
      ) ||
      summary.batches.length !== batches.length
    )
      throw Error('Browser batch summary drift');
    batches.forEach((batch, b) => {
      const name = `batch-${String(b + 1).padStart(3, '0')}`;
      if (
        summary.batches[b].name !== name ||
        summary.batches[b].status !== 'passed' ||
        !equal(
          summary.batches[b].tests,
          batch.tests.map((t) => t.id),
        )
      )
        throw Error('Missing successful browser batch');
      requireBrowserBatch(batch, read(directories[i], `${name}.json`));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name));
  for (const [project, count] of [
    ['mobile-webkit', 4],
    ['mobile-chromium', 3],
    ['desktop-chromium', 3],
  ]) {
    const selected = directories.filter(
      (dir) => JSON.parse(readFileSync(join(dir, 'partition.json'), 'utf8')).project === project,
    );
    requireBrowserPartitionEvidence(selected, project, count);
  }
  if (directories.length !== 10) throw Error('Expected all ten browser partition reports');
  console.log(
    'Every browser project has complete exactly-once coverage and passing actual batch reports',
  );
}
