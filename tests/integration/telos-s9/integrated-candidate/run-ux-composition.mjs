import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

if (process.platform !== 'darwin') throw Error('Select the qualified macOS offline owner');
if (
  !process.env.S9_MGMT_PYTHON ||
  !isAbsolute(process.env.S9_MGMT_PYTHON) ||
  !existsSync(process.env.S9_MGMT_PYTHON)
)
  throw Error('Select the private pinned test Python');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = process.env.S9_UX_OUTPUT_ROOT ?? join(root, 'test-results/telos-s9-ux');
if (!isAbsolute(output)) throw Error('Select an absolute evidence output directory');
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const summary = [];
for (const scenario of ['mobile-dark', 'mobile-light', 'desktop-dark', 'desktop-light']) {
  const directory = join(output, scenario);
  if (existsSync(directory))
    throw Error('Preserve earlier evidence; choose a fresh output directory');
  mkdirSync(directory, { recursive: true });
  const env = {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=1024',
    S9_UX_SCENARIO: scenario,
    S9_JOINED_SCREENSHOT_DIR: directory,
  };
  delete env.S9_MGMT_SOURCE_ROOT;
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      'tests/integration/telos-s9/integrated-candidate/vitest.ux-composition.config.ts',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=' + join(directory, 'run.json'),
    ],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(join(directory, 'stdout.log'), result.stdout ?? '');
  writeFileSync(join(directory, 'stderr.log'), result.stderr ?? '');
  let passed = false;
  let error;
  try {
    const observed = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    passed =
      result.status === 0 &&
      observed.success &&
      observed.numTotalTests === 1 &&
      observed.numPassedTests === 1 &&
      observed.numFailedTests === 0 &&
      observed.numPendingTests === 0 &&
      observed.testResults.length === 1 &&
      observed.testResults[0].assertionResults.length === 1 &&
      observed.testResults[0].assertionResults[0].status === 'passed';
  } catch (caught) {
    error = String(caught);
  }
  const entry = {
    scenario,
    passed,
    exitCode: result.status,
    signal: result.signal,
    result: join(directory, 'run.json'),
    ...(error ? { error } : {}),
  };
  summary.push(entry);
  process.stdout.write(JSON.stringify(entry) + '\n');
}
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (summary.some((entry) => !entry.passed))
  throw Error('Actual UX observations include a required failure; inspect retained evidence');
