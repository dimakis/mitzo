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
let tests = {},
  metrics = {};
try {
  tests = JSON.parse(readFileSync(resultFile, 'utf8'));
  metrics = JSON.parse(readFileSync(metricsFile, 'utf8'));
} catch {}
const report = {
  ...metrics,
  success: run.status === 0,
  durationMs: Math.round(performance.now() - start),
  testCount: tests.numPassedTests ?? 0,
  failedTests: tests.numFailedTests ?? null,
  suites,
  platform: process.platform,
  logFile: join(directory, 'run.log'),
  testsFile: resultFile,
};
const reportFile = join(directory, 'report.json');
writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, reportFile }, null, 2));
process.exit(run.status ?? 1);
