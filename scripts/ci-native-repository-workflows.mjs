import { runBrowserCommand } from './ci-browser-run.mjs';
import { requireJoinedReport } from '../tests/integration/telos-s9/integrated-candidate/joined-shards.mjs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';

export const nativeRepositoryCases = Object.freeze([
  Object.freeze({
    account: 'subscription',
    file: 'server/__tests__/native-local-repository-read-registration.test.ts',
  }),
  Object.freeze({
    account: 'api',
    file: 'server/__tests__/native-local-repository-read-registration-api.test.ts',
  }),
]);
function requireNativeEvidence(value, account) {
  if (
    value.account !== account ||
    value.phase !== 'completed' ||
    !value.coldResume ||
    !value.viewerDetached ||
    value.outcomes?.DiscoverLocalRepository?.state !== 'selected' ||
    !value.outcomes?.InspectLocalRepository?.success ||
    value.outcomes?.PrepareLocalRepository?.state !== 'materialized' ||
    value.outcomes?.denied?.success !== false ||
    value.outcomes?.revoked?.success !== false ||
    !value.outcomes?.custody?.scratchRemoved ||
    !value.outcomes?.handoff?.sameConversation ||
    !value.outcomes?.handoff?.sameThread ||
    !value.outcomes?.handoff?.taskCwdSelected ||
    !value.outcomes?.handoff?.toolsUsable
  )
    throw Error('Incomplete native repository evidence for ' + account);
}
export async function runNativeRepositoryWorkflows({ root, runner = runBrowserCommand }) {
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const base = join(root, 'test-results/native-repository-workflows-processes');
  const evidence = join(root, 'test-results/native-repository-workflows');
  mkdirSync(base, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  // A prior combined reporter cannot stand in for either fresh process result.
  rmSync(join(root, 'test-results/native-repository-workflows.json'), { force: true });
  rmSync(join(base, 'summary.json'), { force: true });
  for (const selected of nativeRepositoryCases) {
    const directory = join(base, selected.account);
    for (const path of [
      join(directory, 'run.json'),
      join(directory, 'exit.json'),
      join(evidence, selected.account + '.json'),
    ])
      rmSync(path, { force: true });
  }
  const summary = [];
  for (const selected of nativeRepositoryCases) {
    const directory = join(base, selected.account);
    mkdirSync(directory, { recursive: true });
    const report = join(directory, 'run.json');
    const proof = join(evidence, selected.account + '.json');
    for (const path of [report, proof, join(directory, 'exit.json')]) rmSync(path, { force: true });
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
      env: {
        ...process.env,
        MITZO_RUN_NATIVE_READ_TOOLS_MECHANICAL: '1',
        MITZO_REQUIRE_NATIVE_REPOSITORY_WORKFLOW: '1',
        MITZO_NATIVE_REPOSITORY_EVIDENCE_DIR: evidence,
      },
      directory,
    });
    const exit = JSON.parse(readFileSync(join(directory, 'exit.json'), 'utf8'));
    try {
      if (code !== 0 || exit.code !== 0 || exit.signal || exit.error || exit.interruptedBy)
        throw Error('Native repository process did not complete successfully');
      const observed = JSON.parse(readFileSync(report, 'utf8'));
      requireJoinedReport(observed, { files: [selected.file] });
      if (
        observed.numTodoTests !== 0 ||
        observed.testResults[0].assertionResults[0].fullName !==
          `registered owned repository workflow survives cold login and viewer detach on ${selected.account} with actual OS fences`
      )
        throw Error('Native repository account case identity changed');
      requireNativeEvidence(JSON.parse(readFileSync(proof, 'utf8')), selected.account);
      summary.push({ ...selected, status: 'passed', report, evidence: proof });
    } catch (error) {
      summary.push({ ...selected, status: 'failed', code, error: String(error) });
    }
    // Native helpers retain their existing own cleanup. A fresh process isolates
    // test JavaScript; cancellation must never admit the next account.
    if (exit.interruptedBy) break;
  }
  writeFileSync(join(base, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (
    summary.length !== nativeRepositoryCases.length ||
    summary.some((entry) => entry.status !== 'passed')
  )
    throw Error('Both complete native repository account workflows must pass');
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin' || process.argv.length !== 2)
    throw Error('Select the complete macOS native repository qualification');
  await runNativeRepositoryWorkflows({ root: fileURLToPath(new URL('..', import.meta.url)) });
}
