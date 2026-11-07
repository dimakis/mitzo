import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getApplicationJoiningJourney } from './collaboration-application-joining-integration.test.js';

// Only the external native process is substituted. Auth, repository preparation,
// ordinary admission/dispatch, driver, SQLite, source provenance and routes are real.
it('delivers a reviewed fresh agent prompt through the actual app and projects its finalized ordinary reply once', async () => {
  const { api, events, group, joinedSessionId } = getApplicationJoiningJourney();
  // index.ts installs this real durable revocation owner in production; the
  // application fixture intentionally does not start index.ts or its services.
  (await import('../auth.js')).setAuthRevocationStore(events);
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  const { registry } = await import('../chat.js');
  // Runtime declaration/qualification is synthetic, just like the external
  // process below. Accept only this fixture's inert bytes, never a host artifact.
  const qualification = await import('../codex-native-artifact-qualification.js');
  const artifact = vi
    .spyOn(qualification, 'assertQualifiedNativeMacExecutionArtifact')
    .mockImplementation((sha256) =>
      expect(sha256).toBe(
        createHash('sha256')
          .update(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]))
          .digest('hex'),
      ),
    );
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let revokeSourceOnQualification = false;
  const launch = vi.spyOn(CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, lifecycle) =>
      ({
        initialize: async () => {},
        close: () => {},
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === 'account/read')
            return {
              account: { type: 'chatgpt', email: 'offline@example.invalid', planType: 'plus' },
            };
          if (method === 'config/read') return { config: {} };
          if (method === 'model/list') {
            if (revokeSourceOnQualification) events.hideSession('existing-chat');
            return {
              data: [
                {
                  model: 'fixture-model',
                  displayName: 'Offline',
                  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                },
              ],
              nextCursor: null,
            };
          }
          if (method === 'thread/start')
            return {
              thread: { id: 'private-native-thread' },
              model: 'fixture-model',
              modelProvider: 'openai',
            };
          if (method === 'turn/start') {
            setTimeout(() => {
              lifecycle!.onNotification('item/completed', {
                threadId: 'private-native-thread',
                turnId: 'private-native-turn',
                item: {
                  id: 'native-answer',
                  type: 'agentMessage',
                  text: 'Reviewed the selected design.',
                },
              });
              lifecycle!.onNotification('turn/completed', {
                threadId: 'private-native-thread',
                turn: { id: 'private-native-turn', status: 'completed' },
              });
            }, 10);
            return { turn: { id: 'private-native-turn' } };
          }
          throw Error(`Unexpected offline native method: ${method}`);
        },
      }) as never,
  );
  try {
    // The source-only observational fixture has never admitted an ordinary
    // command. Do not pretend it is a configured context reader/responder.
    const initial = await api.view(group);
    const source = initial.policies.find((p) => p.sessionId === 'existing-chat')!;
    await api.setPolicy(group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: initial.membershipRevision,
      expectedRevision: source.revision,
      sessionId: source.sessionId,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
    const before = await api.view(group);
    expect(events.getOrdinaryInitialCommandId(joinedSessionId)).toBeUndefined();
    const input = {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: before.membershipRevision,
      expectedPolicySequence: before.policySequence,
      text: 'Review the selected design explicitly',
      responders: { kind: 'selected' as const, sessionIds: [joinedSessionId] },
      snapshot: null,
    };
    await expect(
      api.send(group, {
        ...input,
        requestId: crypto.randomUUID(),
        responders: { kind: 'selected', sessionIds: ['unrelated-session'] },
      }),
    ).rejects.toThrow();
    const linked = events.collaborationConversation.getLinkedJoinForSession(
      group,
      joinedSessionId,
    )!;
    await expect(
      api.send(group, { ...input, requestId: crypto.randomUUID(), snapshot: linked.snapshot }),
    ).rejects.toThrow();
    expect((await api.view(group)).messages).toEqual([]);
    expect(requests).toEqual([]);
    const accepted = await api.send(group, input);
    expect(accepted.deliveries).toMatchObject([{ sessionId: joinedSessionId }]);
    expect(['queued', 'delivered']).toContain(accepted.deliveries[0].status);
    const commandId = accepted.deliveries[0].commandId;
    expect(commandId).toBeTruthy();
    await vi.waitFor(async () => {
      const projected = await api.view(group);
      expect(
        projected.messages.find((m) => m.messageId === accepted.messageId)!.deliveries[0].status,
      ).toBe('delivered');
      const replies = projected.messages.filter(
        (m) => m.replyToDeliveryId === accepted.deliveries[0].deliveryId,
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        text: 'Reviewed the selected design.',
        author: { sessionId: joinedSessionId },
        source: { conversationId: joinedSessionId, commandId },
      });
      expect(JSON.stringify(replies)).not.toContain('private-native-thread');
      expect(JSON.stringify(replies)).not.toContain('private-native-turn');
    });
    const turn = requests.find((r) => r.method === 'turn/start')!;
    expect(JSON.stringify(turn.params)).toContain('Synthetic design requirement');
    expect(JSON.stringify(turn.params)).toContain('Edited brief retained exactly');
    expect(JSON.stringify(turn.params)).toContain(input.text);
    expect(JSON.stringify(turn.params)).not.toContain('DO_NOT_LEAK');
    const retries = await Promise.all([api.send(group, input), api.send(group, input)]);
    expect(retries.map((m) => m.messageId)).toEqual([accepted.messageId, accepted.messageId]);
    await expect(api.send(group, { ...input, text: 'Changed retry' })).rejects.toThrow();
    expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    // Revoke the shared source during actual ordinary preparation. The final
    // provider fence must refuse it even though initial group review succeeded.
    revokeSourceOnQualification = true;
    const next = await api.view(group);
    const refused = await api.send(group, {
      ...input,
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: next.membershipRevision,
      expectedPolicySequence: next.policySequence,
      text: 'Another explicit review',
    });
    expect(refused.deliveries[0].status).toBe('uncertain');
    expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  } finally {
    const live = registry.findBySessionId(joinedSessionId);
    if (live) registry.abort(live.clientId);
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    launch.mockRestore();
    artifact.mockRestore();
  }
}, 30000);
