import { runBrowserCommand } from './ci-browser-run.mjs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

// This owner transfers only these five composed cases from Linux unit shards.
// Native registration's two account workflows retain their separate proof schema.
export const preparedConsumerCases = Object.freeze([
  Object.freeze({
    name: 'delivery',
    file: 'server/__tests__/prepared-repository-delivery-flow.test.ts',
    cases: Object.freeze([
      'recovers exact original delivery after adoption, then accepts repeated explicit prompts and a lost-response continuation without replay',
      'admits a deliberately retried never-admitted stale-workspace prompt through canonical adoption after capability deployment=false without rewriting its frozen browser body',
      'admits a deliberately retried never-admitted stale-workspace prompt through canonical adoption after capability deployment=true without rewriting its frozen browser body',
      'recovers an exact already bridged command only while its earlier attempt never crossed the native dispatch boundary',
    ]),
  }),
  Object.freeze({
    name: 'publication',
    file: 'server/__tests__/prepared-repository-publication-flow.test.ts',
    cases: Object.freeze([
      'commits through native host tools, reviews the exact artifact twice before publication approval, verifies the PR and accepts another prompt',
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
export async function runPreparedConsumers({ root, runner = runBrowserCommand }) {
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const base = join(root, 'test-results/prepared-consumers');
  mkdirSync(base, { recursive: true });
  rmSync(join(base, 'summary.json'), { force: true });
  // Delete every old result before any process starts, including cancellation.
  for (const selected of preparedConsumerCases)
    for (const file of ['run.json', 'exit.json'])
      rmSync(join(base, selected.name, file), { force: true });
  const summary = [];
  for (const selected of preparedConsumerCases) {
    const directory = join(base, selected.name);
    mkdirSync(directory, { recursive: true });
    const report = join(directory, 'run.json');
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
      });
    } catch (error) {
      summary.push({
        name: selected.name,
        file: selected.file,
        status: 'failed',
        code,
        error: String(error),
      });
    }
    if (exit?.interruptedBy) break;
  }
  writeFileSync(join(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (summary.length !== preparedConsumerCases.length || summary.some((r) => r.status !== 'passed'))
    throw Error('All five composed prepared repository cases must pass');
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin' || process.argv.length !== 2)
    throw Error('Select the complete offline macOS prepared consumer owner');
  await runPreparedConsumers({ root: fileURLToPath(new URL('..', import.meta.url)) });
}
