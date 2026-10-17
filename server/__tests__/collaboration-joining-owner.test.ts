import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createJoiningFixture as fixture,
  cleanupJoiningFixtures,
} from './fixtures/collaboration-joining.js';
afterEach(cleanupJoiningFixtures);

it('confirms through real silent preparation and recovers linked joins without a command or second allocation', async () => {
  const f = await fixture();
  const first = await f.owner().confirm('operator', f.group, f.input, f.signal);
  expect(first.state).toBe('linked');
  expect(f.store.getOrdinarySessionPreparation(first.allocationOperationId)?.sessionId).toBe(
    first.sessionId,
  );
  expect(f.store.getOrdinaryInitialCommandId(first.sessionId!)).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(2);
  f.reopen();
  f.resolvePreparation.mockClear();
  expect(await f.owner().recover('operator', f.group, first.joinId, f.signal)).toEqual(first);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  expect(await f.owner().confirm('operator', f.group, f.input, f.signal)).toEqual(first);
  expect(f.store.listSessions()).toHaveLength(2);
});

it('refuses unverified capacity and denied confirmation before any join or reservation', async () => {
  const f = await fixture(false);
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
  f.authority.authorizeConfirmation.mockRejectedValueOnce(new Error('operator denied'));
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow(
    'operator denied',
  );
  expect(f.store.listSessions()).toHaveLength(1);
});

it('recovers crash after actual preparation before allocation recording from the original receipt', async () => {
  const f = await fixture();
  const record = vi
    .spyOn(f.store.collaborationConversation, 'recordAllocation')
    .mockImplementationOnce(() => {
      throw new Error('crash');
    });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow('crash');
  record.mockRestore();
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  const receipt = f.store.getOrdinarySessionPreparation(pending.allocationOperationId)!;
  expect(receipt).toBeDefined();
  f.reopen();
  f.resolvePreparation.mockRejectedValue(new Error('must not allocate again'));
  const recovered = await f.owner().recover('operator', f.group, pending.joinId, f.signal);
  expect(recovered).toMatchObject({
    state: 'linked',
    sessionId: receipt.sessionId,
    allocationOperationId: receipt.allocationOperationId,
  });
  expect(f.store.listSessions()).toHaveLength(2);
});

it('retains allocation when access changes during preparation and requires fresh recovery authority', async () => {
  const f = await fixture();
  let revoked = false;
  const prepare = f.workspaces.prepareOrdinarySession.bind(f.workspaces);
  vi.spyOn(f.workspaces, 'prepareOrdinarySession').mockImplementation(async (...args) => {
    const result = await prepare(...args);
    revoked = true;
    return result;
  });
  f.authority.authorizeJoin.mockImplementation(async () => {
    if (revoked) throw new Error('source changed');
  });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow(
    'source changed',
  );
  const retained = f.store.collaborationConversation.view(f.group).joins[0];
  expect(f.store.getOrdinarySessionPreparation(retained.allocationOperationId)).toBeDefined();
  await expect(f.owner().recover('operator', f.group, retained.joinId, f.signal)).rejects.toThrow(
    'source changed',
  );
  f.authority.authorizeJoin.mockResolvedValue(undefined);
  expect((await f.owner().recover('operator', f.group, retained.joinId, f.signal)).state).toBe(
    'linked',
  );
});

it('preserves the allocated session when membership linking conflicts across restart', async () => {
  const f = await fixture();
  f.authority.authorizeJoin
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      f.store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: 1,
        participantSessionIds: ['source', 'other'],
      });
    });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  const allocated = f.store.collaborationConversation.view(f.group).joins[0];
  expect(allocated.state).toBe('allocated');
  f.reopen();
  await expect(
    f.owner().recover('operator', f.group, allocated.joinId, f.signal),
  ).rejects.toThrow();
  expect(f.store.collaborationConversation.getJoin(f.group, allocated.joinId)).toEqual(allocated);
  expect(f.store.listSessions()).toHaveLength(3);
});

it('freezes caller and authority inputs across awaits', async () => {
  const f = await fixture();
  const original = structuredClone(f.input);
  f.authority.authorizeConfirmation.mockImplementationOnce(async (passed) => {
    passed.input.settings.selection.model = 'callback-mutated';
    f.input.settings.selection.model = 'mutated';
  });
  f.authority.authorizeJoin.mockImplementation(async (passed) => {
    passed.join.settings.selection.model = 'callback-mutated';
    passed.join.allocationOperationId = randomUUID();
    f.input.name = 'mutated';
  });
  const joined = await f.owner().confirm('operator', f.group, f.input, f.signal);
  expect(joined.settings).toEqual(original.settings);
  expect(joined.name).toBe(original.name);
});

it('serializes identity through existing owners across concurrent coordinators', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    f.owner().confirm('operator', f.group, f.input, f.signal),
    f.forkOwner().confirm('operator', f.group, f.input, f.signal),
  ]);
  expect(a).toEqual(b);
  expect(f.store.listSessions()).toHaveLength(2);
});

it('rejects settings absent from the retained assessment before recording a join', async () => {
  const f = await fixture();
  f.input.settings.selection.model = 'changed-model';
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow();
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(f.resolvePreparation).not.toHaveBeenCalled();
});

it('honors cancellation before authority and after resolver without preparing a session', async () => {
  const f = await fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(f.owner().confirm('operator', f.group, f.input, cancelled.signal)).rejects.toThrow();
  expect(f.authority.authorizeConfirmation).not.toHaveBeenCalled();
  const later = new AbortController();
  f.resolvePreparation.mockImplementationOnce(async () => {
    later.abort();
    return {
      binding: {
        accountId: 'unused',
        accountLabel: 'Unused',
        provider: 'openai-codex',
        profileRevision: 'r1',
        model: 'offline-fixture',
      },
      taskRoot: '/unused',
      agentProfile: {} as never,
    };
  });
  await expect(f.owner().confirm('operator', f.group, f.input, later.signal)).rejects.toThrow();
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  expect(pending.state).toBe('pending_preparation');
  expect(f.store.getOrdinarySessionPreparation(pending.allocationOperationId)).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(1);
});

it('reauthorizes after a host resolver await before reserving the ordinary session', async () => {
  const f = await fixture();
  const resolve = f.resolvePreparation.getMockImplementation()!;
  f.resolvePreparation.mockImplementationOnce(async () => {
    const input = await resolve();
    f.authority.authorizeJoin.mockRejectedValue(new Error('revoked while resolving'));
    return input;
  });
  await expect(f.owner().confirm('operator', f.group, f.input, f.signal)).rejects.toThrow(
    'revoked while resolving',
  );
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  expect(pending.state).toBe('pending_preparation');
  expect(f.store.getOrdinarySessionPreparation(pending.allocationOperationId)).toBeUndefined();
  expect(f.store.listSessions()).toHaveLength(1);
});
