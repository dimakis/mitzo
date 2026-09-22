import { describe, expect, it } from 'vitest';
import {
  OPENAI_ROUTE_CANARY_CASES,
  buildOpenAiRouteCanaryArgs,
} from '../run-openai-route-canary.mjs';

describe('OpenAI route canary runner', () => {
  it('pins one deterministic check for every recovery contract', () => {
    expect(OPENAI_ROUTE_CANARY_CASES.map(({ id }) => id)).toEqual([
      'retry-after-persists',
      'provider-reattachment-does-not-admit',
      'ambiguous-retry-requires-confirmation',
      'permanent-failures-stay-non-retryable',
      'telemetry-stays-sanitized',
    ]);

    const args = buildOpenAiRouteCanaryArgs();
    expect(args[0]).toBe('run');
    expect(args).toEqual(
      expect.arrayContaining([
        '--configLoader',
        'runner',
        '--config',
        'scripts/openai-route-canary.vitest.config.mjs',
        'server/__tests__/codex-conversation-store.test.ts',
        'server/__tests__/codex-chat-session.test.ts',
        'server/__tests__/provider-failure.test.ts',
        'frontend/src/components/__tests__/CodexQueueStatus.test.tsx',
      ]),
    );

    const pattern = args[args.indexOf('--testNamePattern') + 1];
    for (const { testName } of OPENAI_ROUTE_CANARY_CASES) expect(pattern).toContain(testName);
  });
});
