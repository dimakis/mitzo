import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import type { OrdinaryLocalCommandAdmission } from '../../packages/protocol/src/ordinary-local-admission.js';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const binding = {
  version: 2 as const,
  account: {
    accountId: 'vertex',
    provider: 'anthropic-vertex' as const,
    profileRevision: 'exact-profile',
  },
  harness: { implementation: 'claude-sdk' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'exact-target' },
};
const meta = {
  sessionId: 'session',
  repositoryWorkspaceId: 'workspace',
  cwd: '/fixture',
  accountBinding: { ...binding.account, accountLabel: 'Vertex', model: 'first' },
};
const command = (id: string, model = 'first') => ({
  clientMsgId: id,
  requestFingerprint: `exact-${id}`,
  payload: { text: id },
  selection: {
    version: 1 as const,
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'ask' as const, revision: 0 },
    model,
    thinking: model === 'first' ? null : 'enabled',
  },
});
function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.admitOrdinaryLocalVertexCommand(meta, binding, command('first'));
  const calls: string[] = [];
  const assertCurrent = vi.fn();
  const query = {
    setModel: vi.fn(async (model: string) => {
      calls.push(`model:${model}`);
    }),
    setMaxThinkingTokens: vi.fn(async (tokens: number | null) => {
      calls.push(`thinking:${tokens}`);
    }),
    push: vi.fn(
      async (
        id: string,
        _admission: Readonly<OrdinaryLocalCommandAdmission>,
        _payload: Readonly<Record<string, unknown>>,
      ) => {
        calls.push(`push:${id}`);
      },
    ),
    abort: vi.fn(),
  };
  const owner = new OrdinaryLocalVertexCommandOwner({
    store,
    sessionId: 'session',
    assertCurrent,
    query,
    settings: (selection) => ({
      model: selection.model,
      thinkingTokens: selection.thinking === null ? null : 10000,
    }),
  });
  return { store, owner, calls, query, assertCurrent };
}
it('changes SDK settings only between terminal commands and preserves queued snapshots', async () => {
  const { store, owner, calls, query } = setup();
  await owner.enqueue('first');
  store.admitOrdinaryLocalVertexContinuation(
    { ...meta, accountBinding: { ...meta.accountBinding, model: 'second' } },
    binding,
    command('second', 'second'),
  );
  await owner.enqueue('second');
  expect(calls).toEqual(['model:first', 'thinking:null', 'push:first']);
  expect(store.getOrdinaryLocalVertexCommandAdmission('second')?.state).toBe('reserved');
  expect(store.getExecutionAdmission('session', 'second')).toBeUndefined();
  await owner.complete('first');
  expect(calls).toEqual([
    'model:first',
    'thinking:null',
    'push:first',
    'model:second',
    'thinking:10000',
    'push:second',
  ]);
  expect(query.push.mock.calls[1][1].selection.model).toBe('second');
  expect(store.getOrdinaryLocalVertexCommandAdmission('first')?.selection.model).toBe('first');
  expect(store.getOrdinaryLocalVertexCommandAdmission('second')?.state).toBe('consumed');
});
it('refuses revoked authority between SDK control acknowledgements without yielding or retrying input', async () => {
  const { store, owner, query, assertCurrent } = setup();
  query.setModel.mockImplementation(async () => {
    assertCurrent.mockImplementation(() => {
      throw Error('revoked');
    });
  });
  await expect(owner.enqueue('first')).rejects.toThrow('revoked');
  expect(query.setMaxThinkingTokens).not.toHaveBeenCalled();
  expect(query.push).not.toHaveBeenCalled();
  expect(query.abort).toHaveBeenCalled();
  expect(store.getOrdinaryLocalVertexCommandAdmission('first')?.state).toBe('uncertain');
  await expect(owner.enqueue('first')).rejects.toThrow();
  expect(query.setModel).toHaveBeenCalledTimes(1);
});
it('rejects foreign result identity before changing running settings', async () => {
  const { owner, query } = setup();
  await owner.enqueue('first');
  await expect(owner.complete('foreign')).rejects.toThrow(
    'SDK result does not match active command',
  );
  expect(query.setModel).toHaveBeenCalledTimes(1);
  expect(query.abort).toHaveBeenCalled();
});
