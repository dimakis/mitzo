import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { collectStagingTextReadEvidence } from '../staging-feature-evidence.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  const binding = {
    accountId: 'stage-personal',
    accountLabel: 'Stage Personal',
    provider: 'openai-codex',
    model: 'gpt-6-luna',
    profileRevision: 'd'.repeat(64),
  };
  store.upsertSession({
    sessionId: 'feature-session',
    accountBinding: binding,
    selectedModel: binding.model,
  });
  const execution = store.beginExecution(
    'feature-session',
    undefined,
    'feature-command',
    'fingerprint',
  );
  const attempt = store.beginProviderAttempt(execution.token, 'provider-1');
  store.append('feature-session', 'block_start', {
    blockId: 'read',
    blockType: 'tool_use',
    toolName: 'Read',
  });
  store.append('feature-session', 'block_end', {
    blockId: 'read',
    blockType: 'tool_use',
    toolName: 'Read',
    toolId: 'read-1',
    rawInput: { type: 'read', path: '/stage-fixture/nonce.txt' },
  });
  store.append('feature-session', 'tool_result', {
    toolId: 'read-1',
    result: 'nonce-unique',
    isError: false,
  });
  store.append('feature-session', 'block_start', { blockId: 'text', blockType: 'text' });
  store.append('feature-session', 'block_delta', {
    blockId: 'text',
    blockType: 'text',
    delta: 'nonce-unique',
  });
  store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'completed');
  store.transitionExecution(execution.token, 'TERMINAL', 'completed');
  const input = {
    sessionId: 'feature-session',
    commandId: 'feature-command',
    binding,
    selectedModel: binding.model,
    fixturePath: '/stage-fixture/nonce.txt',
    nonce: 'nonce-unique',
    afterSeq: 0,
  };
  return { store, input, attempt };
}
it('projects bounded evidence from the actual durable execution, tool and stream records', () => {
  const { store, input } = fixture();
  const result = collectStagingTextReadEvidence(store, input);
  expect(result).toMatchObject({
    sessionId: input.sessionId,
    providerAttemptId: 'provider-1',
    providerDispatches: 1,
  });
  expect(result.observations.map((observation) => observation.feature)).toEqual([
    'stream-text',
    'context-read',
  ]);
  expect(JSON.stringify(result)).not.toContain(input.nonce);
  expect(JSON.stringify(result)).not.toContain(input.fixturePath);
});
it('rejects changed binding/model, another command, a wrong fixture and absent nonce', () => {
  const { store, input } = fixture();
  for (const changed of [
    { ...input, binding: { ...input.binding, accountId: 'other' } },
    { ...input, selectedModel: 'gpt-6-sol' },
    { ...input, commandId: 'other' },
    { ...input, fixturePath: '/other/nonce.txt' },
    { ...input, nonce: 'other' },
  ])
    expect(() => collectStagingTextReadEvidence(store, changed)).toThrow(/unconfirmed/);
});
it('does not substitute a session_end claim for exact provider terminal evidence', () => {
  const { store, input } = fixture();
  store.append(input.sessionId, 'session_end', { sessionId: input.sessionId });
  const execution = store.beginExecution(
    input.sessionId,
    undefined,
    'new-command',
    'new-fingerprint',
  );
  store.beginProviderAttempt(execution.token, 'provider-2');
  expect(() =>
    collectStagingTextReadEvidence(store, { ...input, commandId: 'new-command' }),
  ).toThrow(/unconfirmed/);
});
it('refuses oversized history, wrong event boundaries and additional providers/tools', () => {
  const { store, input } = fixture();
  expect(() => collectStagingTextReadEvidence(store, { ...input, afterSeq: 500 })).toThrow(
    /unconfirmed/,
  );
  store.append(input.sessionId, 'block_end', {
    toolName: 'Write',
    toolId: 'write-1',
    blockType: 'tool_use',
  });
  expect(() => collectStagingTextReadEvidence(store, input)).toThrow(/unconfirmed/);
});
