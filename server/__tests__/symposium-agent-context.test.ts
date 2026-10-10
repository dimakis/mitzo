import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createSymposiumAgentContextBinding,
  SymposiumAgentContextStore,
} from '../symposium-agent-context.js';
import { ContextPackStore } from '../context-pack-store.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
const stores: { close(): void }[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function fixture() {
  const packs = new ContextPackStore(':memory:');
  const store = new SymposiumAgentContextStore(':memory:');
  stores.push(packs, store);
  const pack = packs.publish(
    packs.create({
      version: 1,
      id: 'core',
      name: 'Core',
      description: '',
      tokenBudget: 4000,
      documents: [
        {
          path: 'core.md',
          revision: 'a'.repeat(40),
          mode: 'required',
          headings: [],
          priority: 100,
        },
      ],
      retrievalGuidance: '',
    }).id,
    1,
  );
  const recipe = {
    version: 2 as const,
    source: 'packs' as const,
    packs: [{ id: pack.id, revision: pack.revision, hash: pack.hash }],
    tokenBudget: 4000,
  };
  const profile = {
    profileId: 'agent',
    revision: 1,
    contentHash: 'b'.repeat(64),
    definition: {
      name: 'Agent',
      role: 'agent',
      instructions: 'Use accepted evidence.',
      expectedOutput: 'Text',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent',
      contextRecipe: recipe,
    },
  };
  profile.contentHash = createHash('sha256')
    .update(JSON.stringify(profile.definition))
    .digest('hex');
  const execution = {
    sessionId: 's',
    deliveryId: 'd',
    seat: {
      id: 'seat',
      contextRecipe: recipe,
      profileBinding: { profileId: 'agent', profileRevision: '1' },
      contextGrant: { grantId: 'g', revision: 1 },
    },
    claimToken: 'claim',
    content: 'Task',
    signal: new AbortController().signal,
    provenance: { membershipGeneration: 1 },
  } as unknown as SymposiumSeatExecution;
  const readDocument = vi.fn(async () => ({
    storeId: 'accepted-store',
    path: 'core.md',
    revision: 'a'.repeat(40),
    content: '# Core\nPinned instructions.',
  }));
  const assertCurrent = vi.fn();
  const sourceAssertCurrent = vi.fn();
  const binding = createSymposiumAgentContextBinding({
    store,
    profiles: { get: () => profile },
    assertCurrent,
    compileOptions: async () => ({
      packs: {
        sourceIdentity: 'accepted-store',
        resolve: async () => pack,
        authorize: async () => {},
        readDocument,
        assertCurrent: sourceAssertCurrent,
      },
    }),
  });
  return { binding, store, execution, readDocument, profile, assertCurrent, sourceAssertCurrent };
}
it('persists exact prepared context and reuses immutable same-seat generation snapshots', async () => {
  const { binding, store, execution, readDocument } = fixture();
  const first = await binding.prepare(execution);
  expect(first?.bootContext).toContain('Pinned instructions');
  expect(store.getPrepared(execution)?.snapshot.payloadHash).toBe(first?.snapshot.payloadHash);
  const second = await binding.prepare({ ...execution, claimToken: 'another' });
  expect(second).toEqual(first);
  expect(readDocument).toHaveBeenCalledTimes(1);
  binding.accepted(execution, first!, 'thread', 'turn');
  expect(store.acceptances(execution)).toMatchObject([
    {
      claimToken: 'claim',
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      payloadHash: first!.snapshot.payloadHash,
    },
  ]);
});
it('fails closed for missing profile adapter, changed granted recipe and revoked preparation', async () => {
  const { binding, execution, assertCurrent } = fixture();
  expect(
    await binding.prepare({ ...execution, seat: { ...execution.seat, contextRecipe: undefined } }),
  ).toBeUndefined();
  const changed = {
    ...execution,
    seat: { ...execution.seat, profileBinding: { profileId: 'agent', profileRevision: '2' } },
  };
  await expect(binding.prepare(changed)).rejects.toThrow(/profile/);
  assertCurrent.mockImplementation(() => {
    throw Error('revoked');
  });
  await expect(binding.prepare(execution)).rejects.toThrow(/revoked/);
});
it('requires exact prepared snapshot and accepts only one immutable provider receipt per claim', async () => {
  const { binding, store, execution } = fixture();
  const prepared = await binding.prepare(execution);
  expect(store.acceptances(execution)).toEqual([]);
  expect(() =>
    binding.accepted(
      execution,
      { ...prepared!, snapshot: { ...prepared!.snapshot, payloadHash: '0'.repeat(64) } },
      't',
      'u',
    ),
  ).toThrow(/snapshot/);
  binding.accepted(execution, prepared!, 't', 'u');
  binding.accepted(execution, prepared!, 't', 'u');
  expect(() => binding.accepted(execution, prepared!, 'different', 'u')).toThrow(/receipt/);
});
it('delivers compiled boot text through native system context and preserves task text', async () => {
  const { binding, execution } = fixture();
  const prepared = await binding.prepare(execution);
  const { symposiumSeatSystemPrompt } = await import('../symposium-seat-prompt.js');
  const original = execution.content;
  expect(
    symposiumSeatSystemPrompt({ ...execution.seat, systemPrompt: 'Role' }, prepared!.snapshot),
  ).toContain(prepared!.snapshot.context.fullMarkdown);
  expect(execution.content).toBe(original);
});
it('retains prepared payload and provider delivery receipts after process restart', async () => {
  const { binding, execution } = fixture();
  const prepared = await binding.prepare(execution);
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'symposium-context-'));
  const path = join(root, 'context.sqlite');
  try {
    let store = new SymposiumAgentContextStore(path);
    store.prepare(execution, prepared!.snapshot);
    store.accept(execution, prepared!, 'thread', 'turn');
    store.close();
    store = new SymposiumAgentContextStore(path);
    expect(store.getPrepared(execution)).toEqual(prepared);
    expect(store.acceptances(execution)).toMatchObject([
      { providerThreadId: 'thread', providerTurnId: 'turn' },
    ]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('fails native startup if a selected context recipe has no prepared boot snapshot', async () => {
  const { execution } = fixture();
  const { symposiumSeatSystemPrompt } = await import('../symposium-seat-prompt.js');
  expect(() => symposiumSeatSystemPrompt(execution.seat)).toThrow(/prepared/);
});

it('retains the prepared adapter fence and records acknowledged historical delivery after revocation', async () => {
  const { binding, execution, sourceAssertCurrent, assertCurrent, store } = fixture();
  const prepared = await binding.prepare(execution);
  sourceAssertCurrent.mockImplementation(() => {
    throw Error('source scope revoked');
  });
  expect(() => binding.assertCurrent(execution, prepared!)).toThrow(/source scope revoked/);
  assertCurrent.mockImplementation(() => {
    throw Error('operator logged out');
  });
  binding.accepted(execution, prepared!, 'thread', 'turn');
  expect(store.acceptances(execution)).toHaveLength(1);
});
it('rejects a catalog definition whose saved immutable profile hash no longer matches', async () => {
  const { binding, execution, profile } = fixture();
  profile.definition.instructions = 'Tampered';
  await expect(binding.prepare(execution)).rejects.toThrow(/profile integrity/);
});
