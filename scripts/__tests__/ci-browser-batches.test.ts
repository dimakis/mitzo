import { expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  planBrowserBatches,
  requireBrowserBatch,
  runBrowserBatches,
} from '../ci-browser-batches.mjs';

const main = Array.from({ length: 12 }, (_, i) => ({
  id: `case-${i}`,
  project: 'mobile-webkit',
  selector: `[mobile-webkit] › app.spec.ts › case ${i}`,
}));
const setup = {
  id: 'startup',
  project: 'browser-startup-0',
  selector: '[browser-startup-0] › setup.ts › startup',
};
function discovery() {
  return { ended: true, status: 'passed', errors: 0, tests: [setup, ...main] };
}
function complete(tests: typeof main) {
  return {
    ended: true,
    status: 'passed',
    errors: 0,
    tests: [setup, ...tests],
    results: [setup, ...tests].map((test) => ({
      id: test.id,
      status: 'passed',
      expectedStatus: 'passed',
    })),
  };
}
it('bounds each browser lifetime while retaining every selected case and startup dependency', () => {
  const batches = planBrowserBatches(discovery(), 'mobile-webkit', 5);
  expect(batches.map((batch) => batch.tests.length)).toEqual([5, 5, 2]);
  expect(batches.flatMap((batch) => batch.tests.map((test) => test.id))).toEqual(
    main.map((test) => test.id),
  );
  for (const batch of batches) {
    expect(batch.dependencies).toEqual([setup]);
    expect(() => requireBrowserBatch(batch, complete(batch.tests))).not.toThrow();
  }
});
it('rejects incomplete discovery, duplicate identities and unknown project coverage', () => {
  for (const change of ['empty', 'duplicate', 'error', 'unfinished', 'other-project']) {
    const report = discovery();
    if (change === 'empty') report.tests = [setup];
    if (change === 'duplicate') report.tests.push(main[0]);
    if (change === 'error') report.errors = 1;
    if (change === 'unfinished') report.ended = false;
    if (change === 'other-project')
      report.tests.push({ ...main[0], id: 'foreign', project: 'desktop-chromium' });
    expect(() => planBrowserBatches(report, 'mobile-webkit', 5)).toThrow();
  }
});
it.each([
  'missing',
  'duplicate',
  'extra',
  'failed',
  'unexpected-pass',
  'interrupted',
  'error',
  'unfinished',
  'failed-run',
])('rejects %s batch evidence without dropping or hiding failed cases', (change) => {
  const batch = planBrowserBatches(discovery(), 'mobile-webkit', 5)[0];
  const report = complete(batch.tests);
  if (change === 'missing') report.results.pop();
  if (change === 'duplicate') report.results[1] = report.results[0];
  if (change === 'extra') report.tests.push(main[11]);
  if (change === 'failed') report.results[1].status = 'failed';
  if (change === 'unexpected-pass') report.results[1].expectedStatus = 'failed';
  if (change === 'interrupted') report.results[1].status = 'interrupted';
  if (change === 'error') report.errors = 1;
  if (change === 'unfinished') report.ended = false;
  if (change === 'failed-run') report.status = 'failed';
  expect(() => requireBrowserBatch(batch, report)).toThrow();
});
it('retains intentional skips and expected failures but refuses newly skipped required cases', () => {
  const batch = planBrowserBatches(discovery(), 'mobile-webkit', 5)[0];
  const report = complete(batch.tests);
  report.results[1].status = 'skipped';
  expect(() => requireBrowserBatch(batch, report)).toThrow();
  report.results[1].expectedStatus = 'skipped';
  report.results[2].expectedStatus = report.results[2].status = 'failed';
  expect(() => requireBrowserBatch(batch, report)).not.toThrow();
});

it('executes the exact real Playwright selection in fresh browser-free worker batches with retained HTML', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-browser-batch-')));
  try {
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'playwright.config.mjs'),
      `export default {testDir:${JSON.stringify(root)},reporter:[['list'],['html',{open:'never',outputFolder:'report'}]],projects:[{name:'browser-startup-0',testMatch:'setup.spec.js'},{name:'mobile-webkit',testMatch:'cases.spec.js',dependencies:['browser-startup-0']}]};`,
    );
    writeFileSync(
      join(root, 'setup.spec.js'),
      "const {test,expect}=require('@playwright/test');test('startup',()=>expect(true).toBe(true));",
    );
    writeFileSync(
      join(root, 'cases.spec.js'),
      "const {test,expect}=require('@playwright/test');for(let i=0;i<12;i++)test('case '+i,()=>expect(i).toBeLessThan(12));test('intentional skip',()=>test.skip());test('expected failure',()=>{test.fail();expect(1).toBe(2)});",
    );
    expect(
      runBrowserBatches({
        root,
        config: join(root, 'playwright.config.mjs'),
        args: ['--project=mobile-webkit', '--shard=1/1'],
        size: 5,
      }),
    ).toBe(0);
    const evidence = join(root, 'test-results/offline/evidence');
    const summary = JSON.parse(readFileSync(join(evidence, 'summary.json'), 'utf8'));
    expect(summary.selected.length).toBe(14);
    expect(summary.batches.map((batch: { tests: string[] }) => batch.tests.length)).toEqual([
      5, 5, 4,
    ]);
    const reports = summary.batches.map((batch: { name: string }) =>
      JSON.parse(readFileSync(join(evidence, batch.name + '.json'), 'utf8')),
    );
    expect(new Set(reports.map((report: { pid: number }) => report.pid)).size).toBe(3);
    for (const batch of summary.batches)
      expect(
        readFileSync(join(root, 'playwright-report/offline', batch.name, 'index.html'), 'utf8'),
      ).toContain('<!DOCTYPE html>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
