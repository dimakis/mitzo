import { describe, expect, it } from 'vitest';
import type { EventStore } from '../event-store.js';
import type { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
import { collectStagingNativeTextReadEvidence } from '../staging-native-feature-evidence.js';
const nonce = 'b'.repeat(64);
const binding = {
  accountId: 'fresh-stage',
  provider: 'openai' as const,
  model: 'luna',
  profileRevision: 'revision',
};
function fixture() {
  const provenance = {
    seatId: 'primary',
    membershipGeneration: 1,
    accountProfileRevision: 'revision',
  };
  const attempt = {
    claimToken: 'claim',
    status: 'delivered',
    acceptedAt: 1,
    provenance,
    providerThreadId: 'thread',
    providerTurnId: 'turn',
  };
  const observation = {
    status: 'completed',
    terminalAt: 2,
    terminalConflict: false,
    identity: {
      claimToken: 'claim',
      sessionId: 'session',
      seatId: 'primary',
      accountBinding: binding,
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      membershipGeneration: 1,
      provenance,
    },
  };
  const events = [
    {
      type: 'block_end',
      payload: {
        blockType: 'tool_use',
        toolName: 'Read',
        toolId: 'read',
        rawInput: { file_path: '/sandbox/workspaces/mgmt/nonce.txt' },
      },
    },
    { type: 'tool_result', payload: { toolId: 'read', isError: false, result: nonce } },
    { type: 'block_start', payload: { blockType: 'text', blockId: 'text' } },
    { type: 'block_delta', payload: { blockId: 'text', delta: nonce } },
  ].map((event) => ({
    ...event,
    sessionId: 'session',
    seatId: 'primary',
    symposiumProvenance: provenance,
    payload: { ...event.payload, nativeClaimToken: 'claim' },
  }));
  const delivery = { sessionId: 'session', status: 'delivered', recipientSeatIds: ['primary'] };
  const store = {
    getSymposiumDelivery: () => delivery,
    getSymposiumRecipientAttempts: () => [attempt],
    getEventsAfter: () => events,
  } as unknown as EventStore;
  const registry = {
    get: () => ({ sessionId: 'session' }),
    observations: { get: () => observation },
  } as unknown as SymposiumAttemptRegistry;
  const input = {
    sessionId: 'session',
    deliveryId: 'delivery',
    binding,
    nonce,
    fixturePath: '/sandbox/workspaces/mgmt/nonce.txt',
    afterSeq: 0,
  };
  return { store, registry, input, attempt, observation, events, delivery };
}
describe('actual native app text/tool observations', () => {
  it('collects only the exact completed accepted native claim and attributed Read/text', () => {
    const f = fixture();
    const receipt = collectStagingNativeTextReadEvidence(f.store, f.registry, f.input);
    expect(receipt).toMatchObject({
      claimToken: 'claim',
      generation: 1,
      providerThreadId: 'thread',
      durableEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipt.observations.map((value) => value.feature)).toEqual([
      'stream-text',
      'context-read',
    ]);
    expect(JSON.stringify(receipt)).not.toContain(nonce);
    expect(JSON.stringify(receipt)).not.toContain('cleanupConfirmed');
  });
  it.each(['claim', 'account', 'model', 'turn', 'conflict', 'tool', 'nonce', 'bytes', 'terminal'])(
    'refuses %s drift without inferring native success',
    (drift) => {
      const f = fixture();
      if (drift === 'claim') f.events[0].payload.nativeClaimToken = 'other';
      if (drift === 'account') f.input.binding = { ...binding, accountId: 'other' };
      if (drift === 'model') f.input.binding = { ...binding, model: 'sol' };
      if (drift === 'turn') f.attempt.providerTurnId = 'other';
      if (drift === 'conflict') f.observation.terminalConflict = true;
      if (drift === 'tool') Object.assign(f.events[0].payload, { toolName: 'Bash' });
      if (drift === 'nonce') f.input.nonce = 'c'.repeat(64);
      if (drift === 'bytes') Object.assign(f.events[1].payload, { result: 'x'.repeat(65537) });
      if (drift === 'terminal') f.observation.status = 'accepted';
      expect(() => collectStagingNativeTextReadEvidence(f.store, f.registry, f.input)).toThrow(
        /unconfirmed/,
      );
    },
  );
});
