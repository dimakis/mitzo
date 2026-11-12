import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

it('requires retained actual reports from all ten unchanged lanes at the existing browser gate', () => {
  const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as any;
  const offline = workflow.jobs.offline;
  expect(
    offline.strategy.matrix.include.reduce(
      (counts: Record<string, number>, entry: any) => ({
        ...counts,
        [entry.project]: (counts[entry.project] ?? 0) + 1,
      }),
      {},
    ),
  ).toEqual({ 'mobile-webkit': 4, 'mobile-chromium': 3, 'desktop-chromium': 3 });
  expect(
    offline.steps.find((s: any) => s.name === 'Retain complete browser partition evidence'),
  ).toMatchObject({ if: 'always()', with: { 'if-no-files-found': 'error', overwrite: true } });
  const gate = workflow.jobs['browser-validation'];
  expect(gate.steps.some((s: any) => s.run === 'node scripts/ci-browser-gate.mjs')).toBe(true);
  expect(
    gate.steps.find((s: any) => s.name === 'Require complete exactly-once browser inventory'),
  ).toMatchObject({
    if: "needs.changes.outputs.browser == 'true'",
    run: 'node scripts/ci-browser-partition.mjs browser-partitions',
  });
});
