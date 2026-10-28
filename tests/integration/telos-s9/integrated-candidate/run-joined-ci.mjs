import { runBrowserCommand } from '../../../../scripts/ci-browser-run.mjs';
import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseJoinedShardArgs, selectJoinedShard, requireJoinedReport } from './joined-shards.mjs';

// Test-only entry for the existing macOS offline owner. Every required case must
// execute fully. A platform skip or a green default Vitest suite is insufficient.
if (process.platform !== 'darwin')
  throw Error('Joined native artifact qualification requires macOS');
if (
  !process.env.S9_MGMT_PYTHON ||
  !isAbsolute(process.env.S9_MGMT_PYTHON) ||
  !existsSync(process.env.S9_MGMT_PYTHON)
)
  throw Error('Select a private test Python with fixtures/mgmt-read-requirements.txt installed');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const shard = parseJoinedShardArgs(process.argv.slice(2));
const cases = selectJoinedShard(shard);
const failures = [];
const summary = [];
for (const selected of cases) {
  const directory = join(root, 'test-results/telos-s9-joined', selected.name);
  mkdirSync(directory, { recursive: true });
  // A missing fresh reporter must never reuse a previous execution's proof.
  rmSync(join(directory, 'run.json'), { force: true });
  const env = {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=1024',
    S9_JOINED_SCREENSHOT_DIR: directory,
    ...(selected.name === 'native-lead-worker-workflow'
      ? { S5B_NATIVE_ROLE_EVIDENCE: join(directory, 'native-role-facts.json') }
      : {}),
  };
  // CI uses retained accepted bytes, never a developer's MGMT checkout.
  delete env.S9_MGMT_SOURCE_ROOT;
  // Give each case its own process group and retire its descendants before the
  // next case. Keep every original test, reporter, environment and deadline.
  const exitCode = await runBrowserCommand({
    command: process.execPath,
    args: [
      vitest,
      'run',
      '--config',
      selected.configPath,
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=' + join(directory, 'run.json'),
    ],
    cwd: root,
    env,
    directory,
  });
  const result = JSON.parse(readFileSync(join(directory, 'exit.json'), 'utf8'));
  try {
    const observed = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    if (exitCode !== 0 || result.signal || result.error)
      throw Error('Joined acceptance process did not complete successfully');
    requireJoinedReport(observed, selected);
    summary.push({ ...selected, status: 'passed', result: join(directory, 'run.json') });
  } catch (error) {
    failures.push(selected.name);
    summary.push({
      ...selected,
      status: 'failed',
      exitCode,
      signal: result.signal,
      error: String(error),
    });
  }
  // Cancellation retires this group and stops admission of later cases. The
  // incomplete summary remains red under the unchanged complete-coverage gate.
  if (result.interruptedBy) break;
}
writeFileSync(
  join(
    root,
    'test-results/telos-s9-joined',
    shard ? `required-summary-${shard.replace('/', '-of-')}.json` : 'required-summary.json',
  ),
  JSON.stringify(summary, null, 2) + '\n',
);
if (failures.length) throw Error('Joined acceptance remains red: ' + failures.join(', '));
