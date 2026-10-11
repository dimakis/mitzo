import { expect, it, vi } from 'vitest';
import { compileAgentContext } from '../agent-context-compiler.js';
import {
  bootContextWithReceipt,
  bootContextWithRetainedReceipt,
  recordAgentContextAcceptance,
} from '../agent-context-delivery.js';
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

it('preserves only an exact validated durable accepted receipt during context refresh', async () => {
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
  const accepted = bootContextWithReceipt(snapshot, 'accepted');
  const retained = JSON.stringify({ ...accepted, scope: 'sandbox' });
  expect(bootContextWithRetainedReceipt(snapshot, retained).receipt.status).toBe('accepted');
  for (const changed of [
    { ...accepted, receipt: { ...accepted.receipt, profileId: 'another' } },
    { ...accepted, receipt: { ...accepted.receipt, profileRevision: 3 } },
    { ...accepted, receipt: { ...accepted.receipt, recipeHash: 'b'.repeat(64) } },
    { ...accepted, receipt: { ...accepted.receipt, compilerRevision: 'another-compiler' } },
    { ...accepted, receipt: { ...accepted.receipt, payloadHash: 'c'.repeat(64) } },
    { ...accepted, receipt: { ...accepted.receipt, status: 'prepared' } },
    { ...accepted, fullMarkdown: 'Another context with a forged matching receipt.' },
    { ...accepted, receipt: { ...accepted.receipt, status: 'invalid' } },
  ]) {
    expect(bootContextWithRetainedReceipt(snapshot, JSON.stringify(changed)).receipt.status).toBe(
      'prepared',
    );
  }
  expect(bootContextWithRetainedReceipt(snapshot, '{invalid json').receipt.status).toBe('prepared');
  expect(bootContextWithRetainedReceipt(snapshot).receipt.status).toBe('prepared');
  const packSnapshot = {
    ...snapshot,
    source: 'packs' as const,
    provenance: {
      packs: [{ id: 'review', revision: 2, hash: 'd'.repeat(64) }],
      documents: [],
      omissions: [],
    },
  };
  const packAccepted = bootContextWithReceipt(packSnapshot, 'accepted');
  expect(
    bootContextWithRetainedReceipt(packSnapshot, JSON.stringify(packAccepted)).receipt.status,
  ).toBe('accepted');
  const changedProvenance = {
    ...packAccepted,
    receipt: {
      ...packAccepted.receipt,
      provenance: {
        ...packSnapshot.provenance,
        packs: [{ id: 'review', revision: 3, hash: 'e'.repeat(64) }],
      },
    },
  };
  expect(
    bootContextWithRetainedReceipt(packSnapshot, JSON.stringify(changedProvenance)).receipt.status,
  ).toBe('prepared');
});
