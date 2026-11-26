import { expect, it } from 'vitest';
import { telosWorkerStartRouteSupported } from '../telos-worker-start-runtime.js';

const binding = (provider: string, implementation: string, location = 'local') =>
  ({
    version: 2,
    account: { accountId: 'account', provider, profileRevision: 'v1' },
    harness: { implementation },
    execution: { location, targetId: 'target', targetRevision: 'v1' },
  }) as never;

it('starts Local Mac Codex workers on ChatGPT and OpenAI-compatible (enMaas) accounts', () => {
  expect(telosWorkerStartRouteSupported(binding('openai-codex', 'codex'))).toBe(true);
  expect(telosWorkerStartRouteSupported(binding('openai', 'codex'))).toBe(true);
});

it('still refuses every route TelosStartSlice cannot start', () => {
  for (const refused of [
    binding('openai', 'codex', 'openshell'),
    binding('openai-codex', 'codex', 'openshell'),
    binding('openai', 'responses'),
    binding('google-vertex', 'gemini'),
    binding('anthropic-claude', 'claude-sdk'),
    binding('anthropic-vertex', 'claude-sdk'),
    binding('anthropic-api', 'claude-sdk'),
    binding('anthropic-claude', 'codex'),
  ])
    expect(telosWorkerStartRouteSupported(refused)).toBe(false);
});
