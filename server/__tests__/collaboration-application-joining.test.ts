import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { revokeAuthSession } from '../auth.js';
import { createApplicationCollaborationJoining } from '../collaboration-application-joining.js';
import {
  fixture,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
// External host location only; private-root guards still inspect real synthetic
// paths. Never canonicalize this developer's credential/configuration directories.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.SYMPOSIUM_OFFLINE_HOME ?? os.homedir() };
});
afterEach(cleanupApplicationReviewFixtures);

async function joiningFixture() {
  for (const key of [
    'CODEX_HOME',
    'MITZO_KEYCHAIN_HELPER',
    'MITZO_KEYCHAIN_CONNECTIONS_DIR',
    'MITZO_KNOWLEDGE_LIBRARY_CONFIG',
    'MITZO_WORKSPACE_RUNTIME_CONFIG',
  ])
    vi.stubEnv(key, undefined);
  const f = await fixture();
  vi.stubEnv('SYMPOSIUM_OFFLINE_HOME', join(f.root, 'home'));
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', join(f.root, 'tasks'));
  const reviewed = await f.review();
  const input = {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings: reviewed.settings,
    snapshot: { snapshotId: reviewed.snapshot.snapshotId, sha256: reviewed.snapshot.sha256 },
  };
  return { ...f, reviewed, input, joining: createApplicationCollaborationJoining(f, f.auth) };
}

it('composes an unmeasured retained review with ordinary silent preparation and original recovery', async () => {
  const f = await joiningFixture();
  const joined = await f.joining.confirm(f.auth.id, f.group, f.input, f.controller.signal);
  expect(joined.state).toBe('linked');
  expect(f.store.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
  expect(f.store.getSessionEvents(joined.sessionId!)).toEqual([]);
  expect(await f.joining.recover(f.auth.id, f.group, joined.joinId, f.controller.signal)).toEqual(
    joined,
  );
  expect(await f.joining.confirm(f.auth.id, f.group, f.input, f.controller.signal)).toEqual(joined);
  expect(f.store.listSessions()).toHaveLength(2);
});

it('refuses a different operator or changed settings before a join or allocation', async () => {
  const f = await joiningFixture();
  await expect(
    f.joining.confirm('another-operator', f.group, f.input, f.controller.signal),
  ).rejects.toThrow();
  await expect(
    f.joining.confirm(
      f.auth.id,
      f.group,
      {
        ...f.input,
        settings: {
          ...f.input.settings,
          selection: { ...f.input.settings.selection, thinking: null },
        },
      },
      f.controller.signal,
    ),
  ).rejects.toThrow();
  expect(f.store.collaborationConversation.view(f.group).joins).toEqual([]);
  expect(f.store.listSessions()).toHaveLength(1);
});

it.each(['hidden source', 'revoked login', 'source access'] as const)(
  'renews %s authority after review without allocating',
  async (change) => {
    const f = await joiningFixture();
    if (change === 'hidden source') f.store.hideSession('source');
    if (change === 'revoked login') revokeAuthSession(f.auth);
    if (change === 'source access') f.access.mockRejectedValue(new Error('Access revoked'));
    const sessionsBefore = f.store.listSessions();
    await expect(
      f.joining.confirm(f.auth.id, f.group, f.input, f.controller.signal),
    ).rejects.toThrow();
    expect(f.store.listSessions()).toEqual(sessionsBefore);
    expect(
      f.store.collaborationConversation.view(f.group).joins.every((row) => row.sessionId === null),
    ).toBe(true);
  },
);

it('recovers a crash after allocation from the same ordinary receipt and frozen source', async () => {
  const f = await joiningFixture();
  const record = vi
    .spyOn(f.store.collaborationConversation, 'recordAllocation')
    .mockImplementationOnce(() => {
      throw Error('Simulated crash after silent allocation');
    });
  await expect(f.joining.confirm(f.auth.id, f.group, f.input, f.controller.signal)).rejects.toThrow(
    'Simulated crash',
  );
  record.mockRestore();
  const pending = f.store.collaborationConversation.view(f.group).joins[0];
  const receipt = f.store.getOrdinarySessionPreparation(pending.allocationOperationId)!;
  expect(receipt).toBeTruthy();
  f.store.append('source', 'user_message', {
    messageId: 'later',
    text: 'Not part of the reviewed snapshot',
  });
  const recovered = await f.joining.recover(
    f.auth.id,
    f.group,
    pending.joinId,
    f.controller.signal,
  );
  expect(recovered).toMatchObject({ state: 'linked', sessionId: receipt.sessionId });
  expect(f.store.listSessions()).toHaveLength(2);
  expect(f.store.getOrdinaryInitialCommandId(receipt.sessionId)).toBeUndefined();
});

it('reconciles a membership conflict explicitly without replacing the original session', async () => {
  const f = await joiningFixture();
  const link = f.store.collaborationConversation.linkJoin.bind(f.store.collaborationConversation);
  vi.spyOn(f.store.collaborationConversation, 'linkJoin').mockImplementationOnce((...args) => {
    f.store.upsertSession({ sessionId: 'another-participant', conversationSource: 'mitzo' });
    f.store.setSessionCollaboration(f.group, {
      expectedRevision: 1,
      participantSessionIds: ['source', 'another-participant'],
    });
    return link(...args);
  });
  await expect(
    f.joining.confirm(f.auth.id, f.group, f.input, f.controller.signal),
  ).rejects.toMatchObject({ code: 'conflict' });
  const retained = f.store.collaborationConversation.view(f.group).joins[0];
  expect(retained.state).toBe('allocated');
  const linked = await f.joining.reconcile(
    f.auth.id,
    f.group,
    retained.joinId,
    {
      requestId: randomUUID(),
      expectedMembershipRevision: 2,
      snapshot: retained.snapshot,
    },
    f.controller.signal,
  );
  expect(linked).toMatchObject({ state: 'linked', sessionId: retained.sessionId });
  expect(f.store.listSessions()).toHaveLength(3);
});
