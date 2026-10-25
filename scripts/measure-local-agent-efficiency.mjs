#!/usr/bin/env node
// Offline only: existing real custody/permission owners with synthetic provider RPC.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'mitzo-efficiency-'));
const metricsFile = join(directory, 'metrics.json'),
  resultFile = join(directory, 'tests.json');
const suites = [
  'local-agent-efficiency-budget',
  'local-agent-efficiency',
  'wait-for-change',
  'agent-tool-catalog',
  'codex-chat-selected-tools',
  'codex-chat-session',
  'codex-conversation',
  'codex-tool-result',
  'codex-mcp-tools',
  'agent-communication',
  'agent-communication-native',
  'session-local-repository-tools',
  'native-local-repository-preparation-registration-dispatch',
  'native-local-repository-preparation-custody',
  'codex-prepared-repository-boundary',
  'local-repository-preparation-source',
  'native-tool-executor',
  'trusted-native-operation',
  'github-publishing-tool',
];
const start = performance.now();
const run = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    ...suites.map((name) => `server/__tests__/${name}.test.ts`),
    '--maxWorkers=1',
    '--reporter=json',
    `--outputFile=${resultFile}`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=1024',
      MITZO_EFFICIENCY_METRICS_FILE: metricsFile,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  },
);
writeFileSync(join(directory, 'run.log'), (run.stdout ?? '') + (run.stderr ?? ''));
// Keep the real public cold consumer in this proof without running unrelated long compound journeys.
const coldResultFile = join(directory, 'cold-tests.json');
const cold =
  run.status === 0
    ? spawnSync(
        process.execPath,
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          'server/__tests__/prepared-repository-native-consumer.test.ts',
          '--testNamePattern',
          'reaches fresh qualified cold admission through the actual public owned entry',
          '--maxWorkers=1',
          '--reporter=json',
          `--outputFile=${coldResultFile}`,
        ],
        {
          cwd: root,
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 10 * 60 * 1000,
        },
      )
    : undefined;
writeFileSync(join(directory, 'cold.log'), (cold?.stdout ?? '') + (cold?.stderr ?? ''));
let coldTests = {};
try {
  coldTests = JSON.parse(readFileSync(coldResultFile, 'utf8'));
} catch {}
let tests = {},
  metrics = {};
try {
  tests = JSON.parse(readFileSync(resultFile, 'utf8'));
  metrics = JSON.parse(readFileSync(metricsFile, 'utf8'));
} catch {}
const report = {
  ...metrics,
  success: run.status === 0 && cold?.status === 0 && coldTests.numPassedTests === 1,
  durationMs: Math.round(performance.now() - start),
  testCount: (tests.numPassedTests ?? 0) + (coldTests.numPassedTests ?? 0),
  failedTests:
    tests.numFailedTests === undefined || coldTests.numFailedTests === undefined
      ? null
      : tests.numFailedTests + coldTests.numFailedTests,
  suites,
  targetedCases: ['prepared-repository-native-consumer: public qualified cold admission'],
  platform: process.platform,
  logFile: join(directory, 'run.log'),
  testsFile: resultFile,
  targetedTestsFile: coldResultFile,
  targetedLogFile: join(directory, 'cold.log'),
};
const reportFile = join(directory, 'report.json');
writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, reportFile }, null, 2));
process.exit(run.status === 0 && cold?.status === 0 && coldTests.numPassedTests === 1 ? 0 : 1);
