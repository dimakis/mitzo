import { expect, it } from 'vitest';
import { SessionRuntimeBindingV2Schema } from '../session-runtime-binding.js';
import { supportsUserTurnSteering } from '../codex-steering.js';

it.each([
  ['codex', 'openai-codex', 'local', true],
  ['codex', 'openai-codex', 'openshell', true],
  ['claude-sdk', 'anthropic-vertex', 'local', true],
  ['claude-sdk', 'anthropic-claude', 'local', true],
  ['claude-sdk', 'anthropic-vertex', 'openshell', false],
  ['claude-sdk', 'anthropic-claude', 'openshell', false],
  ['responses', 'openai', 'local', false],
  ['gemini', 'google-vertex', 'local', false],
] as const)(
  'describes native user steering for %s / %s / %s',
  (implementation, provider, location, supported) => {
    const binding = SessionRuntimeBindingV2Schema.parse({
      version: 2,
      account: { accountId: 'owner', provider, profileRevision: 'profile-r1' },
      harness: { implementation },
      execution: { location, targetId: 'selected', targetRevision: 'target-r1' },
    });
    expect(supportsUserTurnSteering(binding)).toBe(supported);
  },
);
it('does not infer an SDK owner from missing or legacy routing', () => {
  expect(supportsUserTurnSteering(undefined)).toBe(false);
  expect(
    supportsUserTurnSteering({
      version: 1,
      account: { accountId: 'claude', provider: 'anthropic-claude', profileRevision: 'r1' },
      harness: { implementation: 'claude-sdk' },
      execution: { location: 'local' },
    }),
  ).toBe(false);
});
