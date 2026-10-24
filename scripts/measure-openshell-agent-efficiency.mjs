#!/usr/bin/env node
// Offline only. Original sandbox/custody owners with synthetic provider/physical RPC.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'mitzo-openshell-efficiency-'));
const metricsFile = join(directory, 'metrics.json');
const testsFile = join(directory, 'tests.json');
const logFile = join(directory, 'run.log');
const suites = [
  'codex-chat-session',
  'codex-chat-selected-tools',
  'codex-conversation',
  'codex-conversation-store',
  'codex-tool-result',
  'integration-tool-discovery',
  'local-agent-efficiency',
  'owned-openshell-codex-chat-consumer',
  'owned-openshell-codex-command-start',
  'ordinary-openshell-codex-owned-runtime',
  'ordinary-openshell-codex-entry-owner',
  'ordinary-openshell-codex-entry-role',
  'openshell-runtime',
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
    `--outputFile=${testsFile}`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=1024',
      MITZO_OPENSHELL_EFFICIENCY_METRICS_FILE: metricsFile,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  },
);
writeFileSync(logFile, (run.stdout ?? '') + (run.stderr ?? ''));
let metrics, tests;
try {
  metrics = JSON.parse(readFileSync(metricsFile, 'utf8'));
  tests = JSON.parse(readFileSync(testsFile, 'utf8'));
} catch {}
const measured =
  Number.isFinite(metrics?.schemaByteReduction) && Number.isFinite(metrics?.outputByteReduction);
const success =
  run.status === 0 && tests?.numPassedTests > 0 && tests?.numFailedTests === 0 && measured;
const reportFile = join(directory, 'report.json');
const report = {
  ...metrics,
  success,
  testCount: tests?.numPassedTests ?? 0,
  failedTests: tests?.numFailedTests ?? null,
  durationMs: Math.round(performance.now() - start),
  platform: process.platform,
  suites,
  logFile,
  testsFile,
  reportFile,
};
writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(success ? 0 : 1);
