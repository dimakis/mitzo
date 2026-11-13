import { afterAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const journey = createApplicationJourney();
afterAll(() => journey.close());

it('lets an ordinary lead recruit a saved planner, read its attributed result and request independent review without replay', async () => {
  const h = await journey.getApplicationUiJourney();
  const { getSpecialistConsultations } = await import('../specialist-consultation-runtime.js');
  const { captureAgentLibraryAuthorization } = await import('../agent-library-transport.js');
  const { getAgentLibrary } = await import('../agent-library-runtime.js');
  const { setAuthRevocationStore } = await import('../auth.js');
  const auth = captureAgentLibraryAuthorization(h.clientId);
  setAuthRevocationStore(h.events);
  const service = getSpecialistConsultations();
  const library = getAgentLibrary();
  for (const role of ['planner', 'plan-reviewer']) {
    library.saveDraft('user', {
      profileId: role,
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: `draft-${role}`,
      definition: {
        name: role,
        role,
        instructions: `Act as ${role}.`,
        expectedOutput: 'Evidence and recommendations',
        acceptanceCriteria: ['Cite evidence'],
        modelPolicyRole: role,
      },
    });
    library.publish('user', {
      profileId: role,
      expectedVersion: 1,
      idempotencyKey: `publish-${role}`,
    });
  }
  // The lead's answers return through its authenticated tool result. Other
  // existing group members may not silently read consultation assignments.
  const view = await h.api.view(h.group);
  for (const policy of view.policies) {
    if (policy.readsFutureDiscussion)
      await h.api.setPolicy(h.group, {
        requestId: crypto.randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        expectedRevision: policy.revision,
        sessionId: policy.sessionId,
        readsFutureDiscussion: false,
        repliesByDefault: false,
      });
  }
  const authority = {
    leadSessionId: 'existing-chat',
    operatorConnectionId: h.clientId,
    auth: auth.auth,
    signal: new AbortController().signal,
    assertCurrent: () => auth.assertCurrent(),
  };
  const catalog = await service.catalog(authority);
  expect(catalog.profiles.map((p) => p.role)).toEqual(
    expect.arrayContaining(['planner', 'plan-reviewer']),
  );
  const approve = vi.fn(async () => true);
  const policy = await service.authorize(
    authority,
    {
      requestId: crypto.randomUUID(),
      connectionId: catalog.repositories[0].connectionId,
      repository: 'example/acceptance',
      durationMinutes: 10,
      maxConsultations: 3,
      maxContextBytes: 32000,
      routes: ['planner', 'plan-reviewer'].map((role) => ({
        role,
        accountId: 'offline-personal',
        model: 'fixture-model',
        reasoningEffort: 'low',
        runOn: 'local',
        targetId: 'offline-observation',
      })),
    },
    approve,
  );
  expect(approve).toHaveBeenCalledOnce();
  expect(approve.mock.calls[0][0]).toMatchObject({
    maxConsultations: 3,
    specialistPermissionMode: 'ask',
  });
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  const native = await recordApplicationMessagingRuntime(h.events);
  try {
    const input = {
      requestId: crypto.randomUUID(),
      role: 'planner',
      assignment: 'Plan the change.',
      messageIds: ['selected-source'],
      artifacts: [],
    };
    const first = await service.consult(authority, policy.policyId, input);
    expect(
      first.receipt.state,
      readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('specialist-consultation'))
        .join('\n'),
    ).toBe('dispatched');
    await vi.waitFor(() =>
      expect(service.read(authority, input.requestId).status).toBe('completed'),
    );
    const planned = service.read(authority, input.requestId);
    expect(planned.contributions[0]).toMatchObject({
      role: 'planner',
      profileId: 'planner',
      text: 'Reviewed the selected design.',
    });
    expect(JSON.stringify(planned)).not.toContain('DO_NOT_LEAK');
    const repeated = await service.consult(authority, policy.policyId, input);
    expect(repeated.receipt.sessionId).toBe(first.receipt.sessionId);
    expect(native.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    const reviewed = {
      ...input,
      requestId: crypto.randomUUID(),
      role: 'plan-reviewer',
      assignment: 'Review the plan independently.',
      reviewOf: input.requestId,
      messageIds: [],
    };
    const second = await service.consult(authority, policy.policyId, reviewed);
    expect(second.receipt.sessionId).not.toBe(first.receipt.sessionId);
    expect(second.independence).toMatchObject({ independent: true, differentFamily: false });
    await vi.waitFor(() =>
      expect(service.read(authority, reviewed.requestId).status).toBe('completed'),
    );
    expect(native.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    const starts = native.requests.filter((r) => r.method === 'turn/start');
    expect(JSON.stringify(starts[1].params)).toContain('Reviewed the selected design.');
    expect(JSON.stringify(starts[1].params)).not.toContain('Synthetic design requirement');
    service.revoke(authority, policy.policyId);
    await expect(
      service.consult(authority, policy.policyId, { ...input, requestId: crypto.randomUUID() }),
    ).rejects.toThrow(/revoked/);
    expect(service.read(authority, input.requestId).status).toBe('completed');
  } finally {
    const { registry } = await import('../chat.js');
    for (const entry of registry.entries(true)) registry.abort(entry[0]);
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    native.restore();
  }
}, 30000);
