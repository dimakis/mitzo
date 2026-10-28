import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

function sameIds(expected, actual) {
  const ids = (values) => values.map((value) => value.id).sort();
  return (
    Array.isArray(actual) &&
    new Set(ids(actual)).size === actual.length &&
    JSON.stringify(ids(expected)) === JSON.stringify(ids(actual))
  );
}
export function planBrowserBatches(report, project, size = 5) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    !report.ended ||
    report.status !== 'passed' ||
    report.errors !== 0 ||
    !Array.isArray(report.tests) ||
    !report.tests.length ||
    !sameIds(report.tests, report.tests)
  )
    throw Error('Browser shard discovery did not complete successfully');
  const dependencies = report.tests.filter((test) => test.project.startsWith('browser-startup-'));
  const tests = report.tests.filter((test) => test.project === project);
  if (
    !tests.length ||
    tests.length + dependencies.length !== report.tests.length ||
    report.tests.some(
      (test) =>
        typeof test.id !== 'string' ||
        !test.id ||
        typeof test.selector !== 'string' ||
        /[\r\n]/.test(test.selector),
    )
  )
    throw Error('Unknown or empty browser shard selection');
  const batches = [];
  for (let offset = 0; offset < tests.length; offset += size)
    batches.push({ tests: tests.slice(offset, offset + size), dependencies });
  return batches;
}
export function requireBrowserBatch(batch, report) {
  const expected = [...batch.dependencies, ...batch.tests];
  if (!sameIds(expected, report.tests))
    throw Error(
      'Browser batch selection drift: ' +
        JSON.stringify({ expected: expected.map((test) => test.selector), observed: report.tests }),
    );
  if (
    !report.ended ||
    report.status !== 'passed' ||
    report.errors !== 0 ||
    !sameIds(expected, report.tests) ||
    !sameIds(expected, report.results) ||
    report.results.some(
      (result) =>
        !['passed', 'failed', 'skipped'].includes(result.status) ||
        result.status !== result.expectedStatus,
    )
  )
    throw Error('Browser batch has missing, duplicated, interrupted or unexpected outcomes');
}
export function runBrowserBatches({
  args,
  root = process.cwd(),
  config = 'playwright.offline.config.ts',
  size = 5,
  output = 'test-results/offline',
  html = 'playwright-report/offline',
}) {
  const projectArg = args.find((arg) =>
    /^--project=(mobile-webkit|mobile-chromium|desktop-chromium)$/.test(arg),
  );
  const shardArg = args.find((arg) => /^--shard=[1-9][0-9]*\/[1-9][0-9]*$/.test(arg));
  if (args.length !== 2 || !projectArg || !shardArg)
    throw Error('Select one complete CI project and shard');
  const project = projectArg.slice('--project='.length);
  const [index, count] = shardArg.slice('--shard='.length).split('/').map(Number);
  if (index > count) throw Error('Invalid browser shard');
  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  const cli = resolve(scriptRoot, '../node_modules/playwright/cli.js');
  const reporter = join(scriptRoot, 'ci-browser-batch-reporter.mjs');
  const resultRoot = resolve(root, output),
    evidence = join(resultRoot, 'evidence');
  mkdirSync(evidence, { recursive: true });
  const discoveryPath = join(evidence, 'discovery.json');
  rmSync(discoveryPath, { force: true });
  const invoke = (flags, reportPath, htmlDirectory) =>
    spawnSync(
      process.execPath,
      [
        cli,
        'test',
        '--config',
        config,
        ...flags,
        '--workers=1',
        '--retries=0',
        '--add-reporter',
        reporter,
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          MITZO_BROWSER_BATCH_REPORT: reportPath,
          PLAYWRIGHT_HTML_OUTPUT_DIR: htmlDirectory,
        },
      },
    );
  const discovered = invoke(
    [...args, '--list', '--output', join(resultRoot, 'discovery')],
    discoveryPath,
    resolve(root, html, 'discovery'),
  );
  if (discovered.status !== 0 || discovered.signal || discovered.error)
    throw Error('Browser discovery process failed');
  const selection = JSON.parse(readFileSync(discoveryPath, 'utf8'));
  const batches = planBrowserBatches(selection, project, size);
  const summary = [];
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index],
      name = `batch-${String(index + 1).padStart(3, '0')}`;
    const listPath = join(evidence, name + '.txt'),
      reportPath = join(evidence, name + '.json');
    rmSync(reportPath, { force: true });
    writeFileSync(
      listPath,
      [
        ...new Set(
          [...batch.dependencies, ...batch.tests].flatMap((test) => [
            test.selector,
            test.loadSelector ?? test.selector,
          ]),
        ),
      ].join('\n') + '\n',
    );
    console.log(
      `CI_BROWSER_BATCH ${index + 1}/${batches.length}: ${batch.tests.length} selected cases; fresh worker and browser`,
    );
    const result = invoke(
      [projectArg, '--test-list', listPath, '--output', join(resultRoot, name)],
      reportPath,
      resolve(root, html, name),
    );
    try {
      if (result.status !== 0 || result.signal || result.error)
        throw Error('Browser batch process failed');
      requireBrowserBatch(batch, JSON.parse(readFileSync(reportPath, 'utf8')));
      summary.push({ name, status: 'passed', tests: batch.tests.map((test) => test.id) });
    } catch (error) {
      console.error(
        'CI_BROWSER_TEST_FAILURE ' +
          JSON.stringify({ status: 'batch-evidence', batch: name, error: String(error) }),
      );
      summary.push({ name, status: 'failed', tests: batch.tests.map((test) => test.id) });
    }
  }
  writeFileSync(
    join(evidence, 'summary.json'),
    JSON.stringify(
      {
        selected: selection.tests.filter((test) => test.project === project).map((test) => test.id),
        batches: summary,
      },
      null,
      2,
    ) + '\n',
  );
  if (summary.some((batch) => batch.status !== 'passed'))
    throw Error('Every selected browser batch must pass');
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBrowserBatches({ args: process.argv.slice(2) });
