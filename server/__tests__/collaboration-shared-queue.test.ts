import { afterAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());

// Real HTTP, authorization, durable command admission and native FIFO. Only
// external native processes are recorded; no model or live app is contacted.
it('admits one shared queued prompt behind an active turn and recovers its exact identity', async () => {
  const { api, events, group, joinedSessionId } = await journey.initializeReviewedJoin();
  (await import('../auth.js')).setAuthRevocationStore(events);
  const runtime = await recordApplicationMessagingRuntime(events);
  const { registry } = await import('../chat.js');
  try {
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
    const view = await api.view(group);
    const input = {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: 'First active turn',
      responders: { kind: 'selected' as const, sessionIds: [joinedSessionId] },
      snapshot: null,
    };
    runtime.holdTurn(1);
    await api.send(group, input);
    await vi.waitFor(() =>
      expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1),
    );
    expect(await api.recipientReadiness(group, joinedSessionId)).toMatchObject({ ready: true });
    const queued = {
      ...input,
      requestId: crypto.randomUUID(),
      text: 'Run only after the first turn',
    };
    const receipt = await api.send(group, queued);
    expect(receipt.deliveries[0]).toMatchObject({ status: 'queued' });
    const originalCommand = receipt.deliveries[0].commandId;
    expect(originalCommand).toBeTruthy();
    expect((await api.observeSend(group, queued)).message?.deliveries[0].commandId).toBe(
      originalCommand,
    );
    expect((await api.send(group, queued)).messageId).toBe(receipt.messageId);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    await vi.waitFor(() => runtime.finishTurn(1, 'completed'));
    await vi.waitFor(() =>
      expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2),
    );
    await vi.waitFor(async () =>
      expect((await api.observeSend(group, queued)).terminal).toBe(true),
    );
    expect(
      runtime.requests.some((r) => r.method === 'turn/steer' || r.method === 'turn/interrupt'),
    ).toBe(false);
    expect((await api.send(group, queued)).deliveries[0].commandId).toBe(originalCommand);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  } finally {
    const live = registry.findBySessionId(joinedSessionId);
    if (live) registry.abort(live.clientId);
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    runtime.restore();
  }
}, 60_000);
