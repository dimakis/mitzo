import { expect, it } from 'vitest';
import { sessionModelSettingsReason } from '../session-model-settings.js';

it('explains immutable legacy SDK settings', () => {
  expect(sessionModelSettingsReason('anthropic-vertex', undefined, false)).toMatch(
    /older Agent SDK chat/,
  );
});
it('explains retired API chats', () => {
  expect(sessionModelSettingsReason('openai', undefined, false)).toMatch(/Continue with Codex/);
});
it.each([
  ['openai-codex', undefined, true],
  ['openai', undefined, true],
  ['anthropic-vertex', 'claude-sdk', false],
  ['openai-codex', 'codex', true],
] as const)('preserves supported runtime %s / %s', (provider, harness, codexBacked) => {
  expect(sessionModelSettingsReason(provider, harness, codexBacked)).toBeUndefined();
});
