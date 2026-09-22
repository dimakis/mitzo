#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const OPENAI_ROUTE_CANARY_CASES = [
  {
    id: 'retry-after-persists',
    checks: [
      {
        file: 'server/__tests__/codex-conversation-store.test.ts',
        testName: 'persists provider retry window across store reopen',
      },
      {
        file: 'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
        testName: 'honors the provider retry window before enabling the saved turn',
      },
    ],
  },
  {
    id: 'provider-reattachment-does-not-admit',
    checks: [
      {
        file: 'server/__tests__/codex-chat-session.test.ts',
        testName: 'reattaches the provider runtime without admitting or replaying user intent',
      },
      {
        file: 'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
        testName:
          'reattaches a disconnected provider in the background while preserving the failed turn',
      },
    ],
  },
  {
    id: 'ambiguous-retry-requires-confirmation',
    checks: [
      {
        file: 'server/__tests__/codex-conversation-store.test.ts',
        testName:
          'requires explicit confirmation for an ambiguous failed turn even without a host tool claim',
      },
      {
        file: 'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
        testName: 'warns before retrying an ambiguous turn that already invoked tools',
      },
    ],
  },
  {
    id: 'permanent-failures-stay-non-retryable',
    checks: [
      {
        file: 'server/__tests__/provider-failure.test.ts',
        ancestor: 'classifyProviderFailure',
        testName: 'distinguishes retryable rate limiting from non-retryable quota exhaustion',
      },
      {
        file: 'server/__tests__/provider-failure.test.ts',
        ancestor: 'classifyProviderFailure',
        testName: 'classifies policy failures',
      },
      {
        file: 'server/__tests__/provider-failure.test.ts',
        ancestor: 'classifyProviderFailure',
        testName: 'classifies authentication failures',
      },
      {
        file: 'server/__tests__/codex-conversation-store.test.ts',
        testName: 'refuses explicit retry for a persisted non-retryable provider failure',
      },
      {
        file: 'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
        testName: 'does not offer retry for a saved non-retryable failure',
      },
    ],
  },
  {
    id: 'telemetry-stays-sanitized',
    checks: [
      {
        file: 'server/__tests__/provider-failure.test.ts',
        ancestor: 'classifyProviderFailure',
        testName: 'produces only stable, sanitized telemetry fields',
      },
      {
        file: 'server/__tests__/provider-failure.test.ts',
        ancestor: 'classifyProviderFailure',
        testName: 'drops unsafe provider codes and clamps invalid retry delays',
      },
    ],
  },
].map((canaryCase) => ({
  ...canaryCase,
  checks: canaryCase.checks.map(({ ancestor, ...check }) => ({
    ...check,
    fullName: ancestor ? `${ancestor} ${check.testName}` : check.testName,
  })),
}));

export function buildOpenAiRouteCanaryArgs(check) {
  return [
    'run',
    check.file,
    '--config',
    'scripts/openai-route-canary.vitest.config.mjs',
    '--configLoader',
    'runner',
    '--testNamePattern',
    `^${check.fullName}$`,
    '--reporter=json',
  ];
}

export function vitestCheckPassed(check, output) {
  try {
    const report = JSON.parse(output);
    const assertions = (report.testResults ?? []).flatMap(
      ({ assertionResults = [] }) => assertionResults,
    );
    return (
      report.success === true &&
      report.numPassedTests === 1 &&
      assertions.some(({ fullName, status }) => fullName === check.fullName && status === 'passed')
    );
  } catch {
    return false;
  }
}

function runVitestCheck(check) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vitest = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
  const result = spawnSync(process.execPath, [vitest, ...buildOpenAiRouteCanaryArgs(check)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    return result.status ?? 1;
  }
  if (!vitestCheckPassed(check, result.stdout ?? '')) {
    process.stderr.write(
      `[openai-route-canary] expected exactly one passing test for: ${check.fullName}\n`,
    );
    return 1;
  }
  return 0;
}

export function runOpenAiRouteCanary(execute = runVitestCheck) {
  for (const { id, checks } of OPENAI_ROUTE_CANARY_CASES) {
    for (const check of checks) {
      process.stdout.write(`[openai-route-canary] ${id}: ${check.testName}\n`);
      const status = execute(check, buildOpenAiRouteCanaryArgs(check));
      if (status !== 0) return status;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runOpenAiRouteCanary();
