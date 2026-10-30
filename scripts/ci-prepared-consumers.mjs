import { runBrowserCommand } from './ci-browser-run.mjs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

// This owner transfers only these seven composed cases from Linux unit shards.
// Native registration's two account workflows retain their separate proof schema.
export const preparedConsumerCases = Object.freeze([
  Object.freeze({
    name: 'delivery',
    file: 'server/__tests__/prepared-repository-delivery-flow.test.ts',
    cases: Object.freeze([
      'recovers exact delivery with API account=false after adoption, later prompts and lost responses',
      'recovers exact delivery with API account=true after adoption, later prompts and lost responses',
      'admits a deliberately retried never-admitted stale-workspace prompt through canonical adoption after capability deployment=false without rewriting its frozen browser body',
      'admits a deliberately retried never-admitted stale-workspace prompt through canonical adoption after capability deployment=true without rewriting its frozen browser body',
      'recovers an exact already bridged command only while its earlier attempt never crossed the native dispatch boundary',
    ]),
  }),
  Object.freeze({
    name: 'publication',
    file: 'server/__tests__/prepared-repository-publication-flow.test.ts',
    cases: Object.freeze([
      'commits, reviews, approves and publishes with API account=false, then accepts another prompt',
      'commits, reviews, approves and publishes with API account=true, then accepts another prompt',
    ]),
  }),
]);
export function requirePreparedConsumerReport(report, selected) {
  const results = report.testResults;
  const assertions = results?.[0]?.assertionResults;
  if (
    report.success !== true ||
    report.numTotalTests !== selected.cases.length ||
    report.numPassedTests !== selected.cases.length ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    results?.length !== 1 ||
    !results[0].name.endsWith('/' + selected.file) ||
    results[0].status !== 'passed' ||
    assertions?.length !== selected.cases.length ||
    assertions.some((test) => test.status !== 'passed') ||
    JSON.stringify(assertions.map((test) => test.fullName).sort()) !==
      JSON.stringify([...selected.cases].sort())
  )
    throw Error('Every composed prepared repository case must pass exactly once: ' + selected.name);
}
export async function runPreparedConsumers({ root, group, runner = runBrowserCommand }) {
  const selection = group
    ? preparedConsumerCases.filter((entry) => entry.name === group)
    : preparedConsumerCases;
  if (!selection.length) throw Error('Unknown prepared consumer group: ' + group);
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const base = join(root, 'test-results/prepared-consumers');
  mkdirSync(base, { recursive: true });
  const summaryPath = join(base, group ? `summary-${group}.json` : 'summary.json');
  rmSync(summaryPath, { force: true });
  // Delete every old result before any process starts, including cancellation.
  for (const selected of selection)
    for (const file of ['run.json', 'exit.json'])
      rmSync(join(base, selected.name, file), { force: true });
  const summary = [];
  for (const selected of selection) {
    const directory = join(base, selected.name);
    mkdirSync(directory, { recursive: true });
    const report = join(directory, 'run.json');
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const code = await runner({
      command: process.execPath,
      args: [
        vitest,
        'run',
        selected.file,
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--reporter=default',
        '--reporter=json',
        '--outputFile=' + report,
      ],
      cwd: root,
      env: { ...process.env, MITZO_CI_PREPARED_CONSUMERS: '0' },
      directory,
    });
    let exit;
    try {
      exit = JSON.parse(readFileSync(join(directory, 'exit.json'), 'utf8'));
      if (code !== 0 || exit.code !== 0 || exit.signal || exit.error || exit.interruptedBy)
        throw Error('Composed consumer process did not complete successfully');
      requirePreparedConsumerReport(JSON.parse(readFileSync(report, 'utf8')), selected);
      summary.push({
        name: selected.name,
        file: selected.file,
        cases: selected.cases.length,
        status: 'passed',
        report,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      summary.push({
        name: selected.name,
        file: selected.file,
        status: 'failed',
        code,
        error: String(error),
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
      });
    }
    if (exit?.interruptedBy) break;
  }
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  if (summary.length !== selection.length || summary.some((r) => r.status !== 'passed'))
    throw Error('All seven composed prepared repository cases must pass');
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin' || process.argv.length > 3)
    throw Error('Select the complete offline macOS prepared consumer owner');
  await runPreparedConsumers({
    root: fileURLToPath(new URL('..', import.meta.url)),
    group: process.argv[2],
  });
}
