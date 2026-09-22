#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const OPENAI_ROUTE_CANARY_CASES = [
  {
    id: 'retry-after-persists',
    files: [
      'server/__tests__/codex-conversation-store.test.ts',
      'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
    ],
    testName:
      '(?:persists provider retry window across store reopen|honors the provider retry window before enabling the saved turn)',
  },
  {
    id: 'provider-reattachment-does-not-admit',
    files: [
      'server/__tests__/codex-chat-session.test.ts',
      'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
    ],
    testName:
      '(?:reattaches the provider runtime without admitting or replaying user intent|reattaches a disconnected provider in the background while preserving the failed turn)',
  },
  {
    id: 'ambiguous-retry-requires-confirmation',
    files: [
      'server/__tests__/codex-conversation-store.test.ts',
      'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
    ],
    testName:
      '(?:requires explicit confirmation for an ambiguous failed turn|warns before retrying an ambiguous turn that already invoked tools)',
  },
  {
    id: 'permanent-failures-stay-non-retryable',
    files: [
      'server/__tests__/provider-failure.test.ts',
      'server/__tests__/codex-conversation-store.test.ts',
      'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
    ],
    testName:
      '(?:distinguishes retryable rate limiting from non-retryable quota exhaustion|classifies policy failures|classifies authentication failures|refuses explicit retry for a persisted non-retryable provider failure|does not offer retry for a saved non-retryable failure)',
  },
  {
    id: 'telemetry-stays-sanitized',
    files: ['server/__tests__/provider-failure.test.ts'],
    testName:
      '(?:produces only stable, sanitized telemetry fields|drops unsafe provider codes and clamps invalid retry delays)',
  },
];

export function buildOpenAiRouteCanaryArgs() {
  const files = [...new Set(OPENAI_ROUTE_CANARY_CASES.flatMap(({ files }) => files))];
  const testNamePattern = OPENAI_ROUTE_CANARY_CASES.map(({ testName }) => `(?:${testName})`).join(
    '|',
  );
  return [
    'run',
    ...files,
    '--config',
    'scripts/openai-route-canary.vitest.config.mjs',
    '--configLoader',
    'runner',
    '--testNamePattern',
    testNamePattern,
  ];
}

export function runOpenAiRouteCanary() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vitest = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
  const result = spawnSync(process.execPath, [vitest, ...buildOpenAiRouteCanaryArgs()], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runOpenAiRouteCanary();
