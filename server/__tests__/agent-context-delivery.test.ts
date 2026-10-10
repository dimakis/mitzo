import { expect, it, vi } from 'vitest';
import { compileAgentContext } from '../agent-context-compiler.js';
import { bootContextWithReceipt, recordAgentContextAcceptance } from '../agent-context-delivery.js';
it('distinguishes prepared context from actual provider acceptance and persists the exact identities', async () => {
  const compiled = await compileAgentContext(
    { version: 1, source: 'contexgin', agentName: 'review' },
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            agent: 'review',
            boot: {
              content: 'Accepted review guidance.',
              tokens: 10,
              tokenBudget: 1000,
              sources: ['review.md'],
            },
          }),
        ),
    },
  );
  const snapshot = { ...compiled, profileId: 'review', revision: 2, profileHash: 'a'.repeat(64) };
  const prepared = bootContextWithReceipt(snapshot);
  expect(prepared.receipt).toMatchObject({
    status: 'prepared',
    profileId: 'review',
    profileRevision: 2,
    payloadHash: snapshot.payloadHash,
  });
  const store = {
    getSession: () => ({ agentContext: snapshot }),
    append: vi.fn(),
    upsertSession: vi.fn(),
  };
  const accepted = recordAgentContextAcceptance({
    store: store as never,
    sessionId: 'chat',
    snapshot,
    commandId: 'command',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    contextSha256: 'b'.repeat(64),
  });
  expect(accepted.receipt.status).toBe('accepted');
  expect(store.append).toHaveBeenCalledWith(
    'chat',
    'agent_context_accepted',
    expect.objectContaining({
      commandId: 'command',
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      payloadHash: snapshot.payloadHash,
      contextSha256: 'b'.repeat(64),
    }),
  );
  expect(store.upsertSession).toHaveBeenCalledWith({
    sessionId: 'chat',
    bootContext: JSON.stringify(accepted),
  });
  expect(snapshot).not.toHaveProperty('receipt');
  store.getSession = () => ({ agentContext: { ...snapshot, payloadHash: 'c'.repeat(64) } });
  expect(() =>
    recordAgentContextAcceptance({
      store: store as never,
      sessionId: 'chat',
      snapshot,
      commandId: 'command',
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      contextSha256: 'b'.repeat(64),
    }),
  ).toThrow(/changed|match/i);
});
