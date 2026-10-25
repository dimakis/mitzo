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
  'agent-flow-consolidation',
  'query-loop',
  'reconstruct-messages',
  'session-credential-tools',
  'openshell-warm-pool',
  'openshell-warm-pool-runtime',
  'openshell-warm-pool-recovery',
  'ordinary-repository-preparation-api',
];
const packageSuites = [
  'packages/harness/__tests__/connection-registry.test.ts',
  'packages/harness/__tests__/live-prefix-delivery.test.ts',
  'packages/client/src/__tests__/applied-delivery.test.ts',
];
const start = performance.now();
const run = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    ...suites.map((name) => `server/__tests__/${name}.test.ts`),
    ...packageSuites,
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
writeFileSync(
  logFile,
  (run.stdout ?? '') + (run.stderr ?? '') + (run.error ? String(run.error) : ''),
);
const readReport = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
// A missing measurement must not hide completed tests or import failures.
const metrics = readReport(metricsFile),
  tests = readReport(testsFile);
const measured =
  Number.isFinite(metrics?.schemaByteReduction) && Number.isFinite(metrics?.outputByteReduction);
const jointPassed =
  tests?.testResults
    ?.find((result) => result.name.endsWith('/agent-flow-consolidation.test.ts'))
    ?.assertionResults?.filter((result) => result.status === 'passed').length ?? 0;
const success =
  run.status === 0 &&
  tests?.numPassedTests > 0 &&
  tests?.numFailedTests === 0 &&
  tests?.numFailedTestSuites === 0 &&
  jointPassed === 2 &&
  measured;
const reportFile = join(directory, 'report.json');
const report = {
  ...metrics,
  success,
  exitCode: run.status,
  signal: run.signal,
  testCount: tests?.numPassedTests ?? 0,
  failedTests: tests?.numFailedTests ?? null,
  failedSuites: tests?.numFailedTestSuites ?? null,
  jointPassed,
  durationMs: Math.round(performance.now() - start),
  platform: process.platform,
  suites,
  packageSuites,
  logFile,
  testsFile,
  reportFile,
};
writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(success ? 0 : 1);
