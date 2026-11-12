import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CollaborationApplicationForwarding } from '../collaboration-application-forwarding.js';
import { ApplicationCollaborationMessaging } from '../collaboration-application-messaging.js';
import {
  fixture,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';
import { registerSymposiumSourceOutput } from './fixtures/symposium-source-output.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
afterEach(cleanupApplicationReviewFixtures);

async function forwardingFixture() {
  const f = await fixture();
  const reviewed = await f.review();
  f.store.admitOrdinaryLocalCommand(
    {
      sessionId: 'recipient',
      cwd: '/fixture',
      mode: reviewed.settings.selection.permission.mode,
      repositoryWorkspaceId: reviewed.settings.repositoryWorkspaceId,
      accountBinding: f.binding,
    },
    reviewed.settings.binding,
    {
      clientMsgId: 'recipient-first',
      requestFingerprint: 'recipient-fingerprint',
      selection: reviewed.settings.selection,
      payload: { text: 'Existing ordinary command' },
    },
  );
  f.store.claimOrdinaryLocalCommandDispatch('recipient-first');
  const group = f.store.setSessionCollaboration(f.group, {
    expectedRevision: 1,
    participantSessionIds: ['source', 'recipient'],
  });
  const source = f.store
    .openCollaborationVisibleSource('source', f.input.selection.boundary)
    .readSelected(['question'])[0];
  const input = {
    selection: {
      requestId: randomUUID(),
      target: {
        collaborationId: f.group,
        expectedMembershipRevision: group.revision,
        sessionIds: ['recipient'],
      },
      sourceConversationId: 'source',
      boundary: f.input.selection.boundary,
      messages: [
        {
          messageId: source.messageId,
          sequence: source.sequence,
          blocks: source.blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
        },
      ],
      artifacts: [] as Array<{
        kind: 'transcript_reference';
        artifactId: string;
        revision: number;
        sha256: string;
      }>,
    },
    note: 'Exact selected source for your next turn.',
  };
  const owner = new CollaborationApplicationForwarding(f.store);
  const prepare = (raw: unknown = input) =>
    owner.prepare(f.auth, f.connectionId, f.group, raw, f.controller.signal);
  return { ...f, owner, input, prepare, settings: reviewed.settings };
}
function confirmation(
  prepared: Awaited<ReturnType<CollaborationApplicationForwarding['prepare']>>,
) {
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: prepared.selection.target.expectedMembershipRevision,
    forward: {
      forwardId: prepared.forwardId,
      packetSha256: prepared.packetSha256!,
      selectionFingerprint: prepared.selectionFingerprint,
    },
    requestReply: false as const,
  };
}

it('prepares exact source context without inference and confirms one durable context-only receipt', async () => {
  const f = await forwardingFixture();
  const sessions = f.store.listSessions();
  expect(
    f.owner.observePreparation(f.auth, f.connectionId, f.group, f.input.selection.requestId),
  ).toBeNull();
  const prepared = await f.prepare();
  expect(
    f.owner.observePreparation(f.auth, f.connectionId, f.group, f.input.selection.requestId),
  ).toEqual(prepared);
  expect(prepared.state).toBe('prepared');
  expect(await f.prepare()).toEqual(prepared);
  expect(JSON.stringify(prepared)).not.toContain('Visible source');
  expect(JSON.stringify(prepared)).not.toContain('PRIVATE');
  expect(f.store.collaborationConversation.view(f.group).messages).toHaveLength(0);
  const input = confirmation(prepared);
  const confirmed = await f.owner.confirm(
    f.auth,
    f.connectionId,
    f.group,
    input,
    f.controller.signal,
  );
  expect(
    await f.owner.confirm(f.auth, f.connectionId, f.group, input, f.controller.signal),
  ).toEqual(confirmed);
  const view = f.store.collaborationConversation.view(f.group);
  expect(view.messages).toHaveLength(1);
  expect(view.messages[0]).toMatchObject({
    text: f.input.note,
    responders: [],
    readers: ['recipient'],
    deliveries: [{ purpose: 'context', status: 'pending', commandId: null }],
  });
  expect(f.store.listSessions()).toEqual(sessions);
  expect(f.store.getOrdinaryInitialCommandId('recipient')).toBe('recipient-first');
  const context = await f.owner.delivery(
    f.auth,
    f.group,
    input.forward,
    ['recipient'],
    f.controller.signal,
  );
  expect(context.material.messages[0].blocks[0].content).toBe('Visible source');
  context.assertRecipient('recipient', f.settings);
  expect(() => context.assertRecipient('source', f.settings)).toThrow();
});

it('recovers original redacted receipts after source revocation but refuses new delivery or changed intent', async () => {
  const f = await forwardingFixture();
  const prepared = await f.prepare();
  const input = confirmation(prepared);
  const confirmed = await f.owner.confirm(
    f.auth,
    f.connectionId,
    f.group,
    input,
    f.controller.signal,
  );
  f.store.hideSession('source');
  expect((await f.prepare()).state).toBe('confirmed');
  expect(f.owner.read(f.auth, f.connectionId, f.group, prepared.forwardId).confirmation).toEqual(
    confirmed,
  );
  expect(
    await f.owner.confirm(f.auth, f.connectionId, f.group, input, f.controller.signal),
  ).toEqual(confirmed);
  await expect(
    f.owner.delivery(f.auth, f.group, input.forward, ['recipient'], f.controller.signal),
  ).rejects.toMatchObject({ code: 'snapshot_changed' });
  await expect(f.prepare({ ...f.input, note: 'Changed retry' })).rejects.toMatchObject({
    code: 'request_conflict',
  });
  await expect(
    f.owner.confirm(
      f.auth,
      f.connectionId,
      f.group,
      { ...input, requestId: randomUUID() },
      f.controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'request_conflict' });
});

it('includes exact registered artifact text and renews source/recipient authority after preparation', async () => {
  const f = await forwardingFixture();
  const output = registerSymposiumSourceOutput(
    f.store,
    'source',
    'Exact forwarded artifact • 台灣\r\n',
  );
  const boundary = { sequence: output.source.messageEndSeq, messageId: output.source.messageId };
  const prepared = await f.prepare({
    ...f.input,
    selection: {
      ...f.input.selection,
      boundary,
      artifacts: [
        {
          kind: 'transcript_reference',
          artifactId: output.outputId,
          revision: output.revision,
          sha256: output.source.sha256,
        },
      ],
    },
  });
  const input = confirmation(prepared);
  await f.owner.confirm(f.auth, f.connectionId, f.group, input, f.controller.signal);
  const context = await f.owner.delivery(
    f.auth,
    f.group,
    input.forward,
    ['recipient'],
    f.controller.signal,
  );
  expect(context.material.artifacts[0].content).toBe('Exact forwarded artifact • 台灣\r\n');
  const membership = f.store.getSessionCollaboration(f.group)!;
  f.store.setSessionCollaboration(f.group, {
    expectedRevision: membership.revision,
    participantSessionIds: ['recipient'],
  });
  f.store.setSessionCollaboration(f.group, {
    expectedRevision: membership.revision + 1,
    participantSessionIds: ['source', 'recipient'],
  });
  expect(context.assertCurrent).toThrow('snapshot_changed');
  await expect(
    f.owner.delivery(f.auth, f.group, input.forward, ['recipient'], f.controller.signal),
  ).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('refuses unsupported artifact bytes before any context confirmation', async () => {
  const f = await forwardingFixture();
  const output = registerSymposiumSourceOutput(f.store, 'source', 'Not text\u0000binary');
  await expect(
    f.prepare({
      ...f.input,
      selection: {
        ...f.input.selection,
        boundary: { sequence: output.source.messageEndSeq, messageId: output.source.messageId },
        artifacts: [
          {
            kind: 'transcript_reference',
            artifactId: output.outputId,
            revision: 1,
            sha256: output.source.sha256,
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: 'execution_unavailable' });
  expect(f.store.collaborationConversation.view(f.group).messages).toHaveLength(0);
});

it.each(['settings', 'removed', 'rejoined', 'aborted'])(
  'refuses changed recipient or request custody before confirmation: %s',
  async (scenario) => {
    const f = await forwardingFixture();
    const prepared = await f.prepare();
    const input = confirmation(prepared);
    if (scenario === 'settings') {
      const current = f.store.getOrdinaryConversationSettings.bind(f.store);
      vi.spyOn(f.store, 'getOrdinaryConversationSettings').mockImplementation((id) => {
        const saved = current(id);
        return id === 'recipient' && saved
          ? { ...saved, selection: { ...saved.selection, model: 'changed-model' } }
          : saved;
      });
    }
    if (scenario === 'removed' || scenario === 'rejoined') {
      const revision = f.store.getSessionCollaboration(f.group)!.revision;
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: revision,
        participantSessionIds: ['source'],
      });
      if (scenario === 'rejoined')
        f.store.setSessionCollaboration(f.group, {
          expectedRevision: revision + 1,
          participantSessionIds: ['source', 'recipient'],
        });
    }
    if (scenario === 'aborted') f.controller.abort();
    await expect(
      f.owner.confirm(f.auth, f.connectionId, f.group, input, f.controller.signal),
    ).rejects.toThrow();
    expect(
      f.owner.read(f.auth, f.connectionId, f.group, prepared.forwardId).confirmation,
    ).toBeNull();
    expect(f.store.collaborationConversation.view(f.group).messages).toEqual([]);
  },
);

it('charges every repeated forwarded artifact before ordinary acceptance or any source recompilation', async () => {
  const f = await forwardingFixture();
  const output = registerSymposiumSourceOutput(f.store, 'source', 'x'.repeat(100000));
  const selection = {
    ...f.input.selection,
    boundary: { sequence: output.source.messageEndSeq, messageId: output.source.messageId },
    artifacts: [
      {
        kind: 'transcript_reference' as const,
        artifactId: output.outputId,
        revision: output.revision,
        sha256: output.source.sha256,
      },
    ],
  };
  for (let i = 0; i < 6; i++) {
    const prepared = await f.prepare({
      ...f.input,
      selection: { ...selection, requestId: randomUUID() },
    });
    await f.owner.confirm(
      f.auth,
      f.connectionId,
      f.group,
      confirmation(prepared),
      f.controller.signal,
    );
  }
  const deliverOrdinary = vi.fn();
  const compile = vi.spyOn(f.owner, 'delivery');
  const messaging = new ApplicationCollaborationMessaging(
    f.store,
    {
      authorized: () => true,
      inspect: async () => ({ busy: false }),
      receipt: () => 'absent',
      deliver: async () => {
        throw Error('Legacy dispatch is unavailable');
      },
      deliverOrdinary,
      close: () => {},
    },
    f.owner,
  );
  const view = f.store.collaborationConversation.view(f.group);
  const input = {
    requestId: randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedPolicySequence: view.policySequence,
    text: 'Explicit response',
    snapshot: null,
    responders: { kind: 'selected' as const, sessionIds: ['recipient'] },
  };
  try {
    await expect(messaging.send(f.auth, f.group, input, f.controller.signal)).rejects.toMatchObject(
      { code: 'capacity_refused' },
    );
    expect(compile).not.toHaveBeenCalled();
    expect(deliverOrdinary).not.toHaveBeenCalled();
    expect(f.store.collaborationConversation.getMessageForRequest(f.group, input)).toBeNull();
    expect(f.store.collaborationConversation.view(f.group).messages).toHaveLength(6);
    for (const message of f.store.collaborationConversation.view(f.group).messages)
      expect(message.deliveries).toMatchObject([{ status: 'pending', commandId: null }]);
  } finally {
    messaging.close();
  }
});
