import { describe, expect, it } from 'vitest';
import {
  OPENAI_ROUTE_CANARY_CASES,
  buildOpenAiRouteCanaryArgs,
  runOpenAiRouteCanary,
  vitestCheckPassed,
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

    const checks = OPENAI_ROUTE_CANARY_CASES.flatMap(({ checks }) => checks);
    expect(checks).toHaveLength(13);
    expect(new Set(checks.map(({ testName }) => testName)).size).toBe(checks.length);

    for (const check of checks) {
      const args = buildOpenAiRouteCanaryArgs(check);
      expect(args[0]).toBe('run');
      expect(args).toEqual(
        expect.arrayContaining([
          '--configLoader',
          'runner',
          '--config',
          'scripts/openai-route-canary.vitest.config.mjs',
          '--reporter=json',
          check.file,
        ]),
      );
      expect(args[args.indexOf('--testNamePattern') + 1]).toBe(`^${check.fullName}$`);
    }
  });

  it('executes every pinned check independently', () => {
    const executed = [];
    expect(
      runOpenAiRouteCanary((check, args) => {
        executed.push({ check, args });
        return 0;
      }),
    ).toBe(0);

    expect(executed).toHaveLength(13);
    for (const { check, args } of executed)
      expect(args[args.indexOf('--testNamePattern') + 1]).toBe(`^${check.fullName}$`);
  });

  it('fails a pinned check when Vitest executes zero matching tests', () => {
    const check = OPENAI_ROUTE_CANARY_CASES[0].checks[0];
    expect(
      vitestCheckPassed(
        check,
        JSON.stringify({
          success: true,
          numPassedTests: 1,
          testResults: [{ assertionResults: [{ fullName: check.fullName, status: 'passed' }] }],
        }),
      ),
    ).toBe(true);
    expect(
      vitestCheckPassed(
        check,
        JSON.stringify({ success: true, numPassedTests: 0, testResults: [] }),
      ),
    ).toBe(false);
  });
});
