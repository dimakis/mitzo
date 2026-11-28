import {
  specialistAuthorizationFixture,
  specialistArtifact,
} from './fixtures/specialist-authorization.js';
import { afterAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const journey = createApplicationJourney();
const approveAdmission = async () => true;
afterAll(() => journey.close());

it('serves operator settings, persists overrides and rejects stale edits through HTTP', async () => {
  const h = await journey.getApplicationUiJourney();
  const endpoint = '/api/specialist-model-policy/existing-chat';
  const initial = await h.fetch(endpoint);
  expect(initial.status).toBe(200);
  const view = await initial.json();
  const request = {
    requestId: crypto.randomUUID(),
    expectedRevision: view.conversation.revision,
    scope: 'conversation',
    policy: {
      models: [
        { accountId: 'offline-personal', model: 'fixture-model', admission: 'auto', allowance: 12 },
      ],
    },
  };
  const saved = await h.fetch(endpoint, { method: 'PUT', body: JSON.stringify(request) });
  expect(saved.status).toBe(200);
  const repeated = await h.fetch(endpoint, { method: 'PUT', body: JSON.stringify(request) });
  expect(await repeated.json()).toEqual(await saved.json());
  const stale = await h.fetch(endpoint, {
    method: 'PUT',
    body: JSON.stringify({ ...request, requestId: crypto.randomUUID() }),
  });
  expect(stale.status).toBe(409);
  expect((await h.fetch('/api/specialist-model-policy/missing')).status).toBe(404);
  await h.fetch(endpoint, {
    method: 'PUT',
    body: JSON.stringify({
      ...request,
      requestId: crypto.randomUUID(),
      expectedRevision: request.expectedRevision + 1,
      policy: null,
    }),
  });
}, 30000);

const authorizationFixture = (role?: string) => specialistAuthorizationFixture(journey, role);

it('replays an exact authorization outside the recent-policy catalog without another approval', async () => {
  const { service, authority, input, approve } = await authorizationFixture();
  const original = await service.authorize(authority, input, approve);
  for (let i = 0; i < 21; i++)
    await service.authorize(authority, { ...input, requestId: crypto.randomUUID() }, approve);
  expect(service.receipts.policies(authority.leadSessionId)).toHaveLength(20);
  expect(
    service.receipts
      .activePolicies(authority.leadSessionId, authority.auth.id)
      .map((entry) => entry.policyId),
  ).toContain(original.policyId);
  const approvals = approve.mock.calls.length;
  await expect(service.authorize(authority, input, approve)).resolves.toEqual(original);
  expect(approve).toHaveBeenCalledTimes(approvals);
}, 30000);

it('reviews editable allowance, requires Ask admission and blocks Off before reservation', async () => {
  const { service, authority, input } = await authorizationFixture();
  const policy = await service.authorize(authority, input, async (display) => ({
    ...display,
    maxConsultations: null,
  }));
  expect(policy.maxConsultations).toBeNull();
  const request = {
    requestId: crypto.randomUUID(),
    role: input.routes[0].role,
    assignment: 'Check policy admission',
  };
  const decline = vi.fn(async () => false);
  await expect(service.consult(authority, policy.policyId, request, decline)).rejects.toThrow(
    /not approved/,
  );
  expect(decline).toHaveBeenCalledOnce();
  expect(service.receipts.find(authority.leadSessionId, request.requestId)).toBeUndefined();
  const current = service.receipts.modelPolicies.read(authority.leadSessionId);
  service.receipts.modelPolicies.save(authority.leadSessionId, {
    requestId: crypto.randomUUID(),
    expectedRevision: current.revision,
    policy: {
      models: [
        {
          accountId: input.routes[0].accountId,
          model: input.routes[0].model,
          admission: 'off',
          allowance: null,
        },
      ],
    },
  });
  await expect(service.consult(authority, policy.policyId, request, decline)).rejects.toThrow(
    /Off/,
  );
  expect(decline).toHaveBeenCalledOnce();
  service.receipts.modelPolicies.save(authority.leadSessionId, {
    requestId: crypto.randomUUID(),
    expectedRevision: current.revision + 1,
    policy: null,
  });
}, 30000);

it('resumes a retried reserved receipt through recovery instead of stranding its allowance slot', async () => {
  const { service, authority, input } = await authorizationFixture();
  const policy = await service.authorize(authority, input, async () => true);
  const request = {
    requestId: crypto.randomUUID(),
    role: input.routes[0].role,
    assignment: 'Resume a reserved receipt',
  };
  const internals = service as unknown as {
    owners: { events: { getDurableSessionTranscript(id: string): { boundary: never } } };
    pending: Map<string, unknown>;
  };
  // A receipt left reserved, e.g. by a concurrent consult's refusal or a restart.
  service.receipts.reserve(
    authority.leadSessionId,
    authority.auth.id,
    policy.policyId,
    request,
    internals.owners.events.getDurableSessionTranscript(authority.leadSessionId).boundary,
    policy.routes[0],
  );
  const resumed = { resumed: true };
  const recover = vi
    .spyOn(service, 'recover')
    .mockResolvedValue(resumed as unknown as Awaited<ReturnType<typeof service.recover>>);
  try {
    internals.pending.set(authority.leadSessionId, { requestId: 'another-request' });
    await expect(
      service.consult(authority, policy.policyId, request, approveAdmission),
    ).rejects.toThrow(/Another consultation is preparing; retain this requestId/);
    expect(recover).not.toHaveBeenCalled();
    // A retry of the request this host is still running joins its result.
    const joined = { joined: true };
    internals.pending.set(authority.leadSessionId, {
      requestId: request.requestId,
      result: Promise.resolve(joined),
    });
    await expect(
      service.consult(authority, policy.policyId, request, approveAdmission),
    ).resolves.toBe(joined);
    expect(recover).not.toHaveBeenCalled();
    internals.pending.delete(authority.leadSessionId);
    await expect(
      service.consult(authority, policy.policyId, request, approveAdmission),
    ).resolves.toBe(resumed);
    expect(recover).toHaveBeenCalledWith(authority, request.requestId, approveAdmission);
  } finally {
    internals.pending.delete(authority.leadSessionId);
    recover.mockRestore();
  }
}, 30000);

it('omits an unresolvable Ask alternative instead of blocking admission for its role', async () => {
  const { service, authority, input } = await authorizationFixture();
  const policy = await service.authorize(authority, input, async () => true);
  const proposed = policy.routes[0];
  const stale = { ...proposed, model: 'retired-fixture-model' };
  const internals = service as unknown as {
    resolveRoute(route: unknown): Promise<unknown>;
    approveModel(
      a: typeof authority,
      p: typeof policy,
      candidates: (typeof proposed)[],
      approve: (display: Record<string, unknown>) => Promise<unknown>,
    ): Promise<{ route: typeof proposed; revision: string }>;
  };
  const original = internals.resolveRoute.bind(service);
  const resolveRoute = vi
    .spyOn(internals, 'resolveRoute')
    .mockImplementation(async (route) =>
      (route as typeof proposed).model === stale.model
        ? Promise.reject(Error('Specialist route runtime unavailable'))
        : original(route),
    );
  try {
    const displays: Record<string, unknown>[] = [];
    await expect(
      internals.approveModel(authority, policy, [proposed, stale], async (display) => {
        displays.push(display);
        return false;
      }),
    ).rejects.toThrow(/not approved/);
    // The operator is still asked, with only the usable proposed route offered.
    expect(displays).toHaveLength(1);
    const routes = displays[0].routes as { model: string; modelPolicyRevision: string }[];
    expect(routes.map((route) => route.model)).toEqual([proposed.model]);
    expect(routes[0].modelPolicyRevision).toBe(displays[0].modelPolicyRevision);
  } finally {
    resolveRoute.mockRestore();
  }
}, 30000);

it('edits a retained policy allowance through its operator route and replays the original authorization', async () => {
  const { h, service, authority, input, approve } = await authorizationFixture();
  const policy = await service.authorize(authority, input, approve);
  const endpoint = `/api/specialist-model-policy/existing-chat/allowances/${policy.policyId}`;
  const edit = { requestId: crypto.randomUUID(), expectedRevision: 0, maxConsultations: null };
  const result = await h.fetch(endpoint, { method: 'PUT', body: JSON.stringify(edit) });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ revision: 1, maxConsultations: null });
  expect((await service.authorize(authority, input, approve)).maxConsultations).toBeNull();
  expect(approve).toHaveBeenCalledOnce();
}, 30000);

it('refuses an oversized UTF-8 envelope before reserving a consultation or workspace', async () => {
  const { service, authority, input, approve, h } = await authorizationFixture();
  const policy = await service.authorize(authority, { ...input, maxContextBytes: 32000 }, approve);
  const requestId = crypto.randomUUID();
  const reserve = vi.spyOn(service.receipts, 'reserve');
  const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
  const workspace = getRepositoryWorkspaces(true);
  const preview = vi.spyOn(workspace, 'preview');
  const prepare = vi.spyOn(workspace, 'prepare');
  const before = h.events.collaborationConversation.view(policy.collaborationId);
  try {
    await expect(
      service.consult(authority, policy.policyId, {
        requestId,
        role: input.routes[0].role,
        assignment: '界'.repeat(12000),
      }),
    ).rejects.toMatchObject({
      code: 'context_limit',
      outcome: 'not_started',
      report: { limitBytes: 32000, components: { assignment: 36000 } },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(service.receipts.find(authority.leadSessionId, requestId)).toBeUndefined();
    expect(h.events.collaborationConversation.view(policy.collaborationId)).toEqual(before);
    // Real tool consumer and service together: no mocked service response.
    const { SessionRegistry } = await import('@mitzo/harness');
    const { sessionProfileTools } = await import('../session-profile-tools.js');
    const { callbackOutcome, TurnCallbacks } = await import('../turn-callbacks.js');
    const registry = new SessionRegistry();
    try {
      registry.register(h.clientId, {
        sessionId: authority.leadSessionId,
        mode: 'agent',
        ownerConnectionId: h.clientId,
        ownedLocalAuthSessionId: authority.auth.id,
        transport: { send() {}, isOpen: () => true },
        abortController: new AbortController(),
        sessionAllowList: new Set(),
      });
      const tool = sessionProfileTools(
        authority.leadSessionId,
        registry.get(h.clientId)!,
        registry,
        '',
        async () => {},
        () => {},
      );
      const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
      const result = await callbacks.track(() =>
        tool.execute(
          'SymposiumConsult',
          {
            operation: 'consult',
            policyId: policy.policyId,
            requestId,
            role: input.routes[0].role,
            assignment: '界'.repeat(12000),
          },
          authority.signal,
          { turnId: 'offline-tool-turn', callId: 'preflight' },
        ),
      );
      expect(JSON.parse(result!.content)).toMatchObject({
        error: 'context_limit',
        outcome: 'not_started',
        stage: 'context_preflight',
        context: { limitBytes: 32000, components: { assignment: 36000 } },
      });
      expect(callbackOutcome(result)).toBe('settled');
      await expect(callbacks.settle(authority.signal)).resolves.toBeUndefined();
      expect(preview).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  } finally {
    reserve.mockRestore();
    preview.mockRestore();
    prepare.mockRestore();
  }
}, 30000);

it('lets an ordinary lead recruit a saved planner, read its attributed result and request independent review without replay', async () => {
  const h = await journey.getApplicationUiJourney();
  const { getSpecialistConsultations } = await import('../specialist-consultation-runtime.js');
  const { captureAgentLibraryAuthorization } = await import('../agent-library-transport.js');
  const { getAgentLibrary } = await import('../agent-library-runtime.js');
  const { setAuthRevocationStore } = await import('../auth.js');
  const auth = captureAgentLibraryAuthorization(h.clientId);
  setAuthRevocationStore(h.events);
  let service = getSpecialistConsultations();
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
        ...(role === 'planner'
          ? {
              contextRecipe: {
                version: 1,
                source: 'workspace',
                files: ['context.md'],
                tokenBudget: 2048,
                required: [],
                excluded: [],
              },
            }
          : {}),
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
  let authority = {
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
  const approve = vi.fn(async (_display: Record<string, unknown>) => true);
  const policy = await service.authorize(
    authority,
    {
      requestId: crypto.randomUUID(),
      connectionId: catalog.repositories[0].connectionId,
      repository: 'example/acceptance',
      durationMinutes: 10,
      maxConsultations: 4,
      maxContextBytes: 32000,
      routes: ['planner', 'plan-reviewer'].map((role) => ({
        role,
        permissionMode: role === 'planner' ? 'auto' : 'agent',
        accountId: 'offline-personal',
        model: 'fixture-model',
        modelFamily: 'synthetic-openai-family',
        reasoningEffort: 'low',
        runOn: 'local',
        targetId: 'offline-observation',
      })),
    },
    approve,
  );
  expect(approve).toHaveBeenCalledOnce();
  expect(approve.mock.calls[0][0]).toMatchObject({
    maxConsultations: 4,
    specialistPermissionModes: [
      { role: 'planner', mode: 'auto' },
      { role: 'plan-reviewer', mode: 'agent' },
    ],
  });
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  let native = await recordApplicationMessagingRuntime(h.events);
  try {
    const artifactText = 'Pinned evidence 界🙂\r\n';
    const artifact = specialistArtifact(h.events, artifactText);
    const input = {
      requestId: crypto.randomUUID(),
      role: 'planner',
      assignment: 'Plan the change. ' + '界'.repeat(6000),
      messageIds: ['selected-source'],
      artifacts: [artifact],
    };
    const savedModels = service.receipts.modelPolicies.read(authority.leadSessionId);
    service.receipts.modelPolicies.save(authority.leadSessionId, {
      requestId: crypto.randomUUID(),
      expectedRevision: savedModels.revision,
      policy: {
        models: [
          {
            accountId: 'offline-personal',
            model: 'fixture-model',
            admission: 'auto',
            allowance: null,
          },
        ],
      },
    });
    const admission = vi.fn(approveAdmission);
    const first = await service.consult(authority, policy.policyId, input, admission);
    expect(admission).not.toHaveBeenCalled();
    expect(
      first.receipt.state,
      readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('specialist-consultation'))
        .join('\n'),
    ).toBe('dispatched');
    expect(
      h.events.getOrdinaryConversationSettings(first.receipt.sessionId!)?.selection.permission.mode,
    ).toBe('auto');
    expect(first.context).toMatchObject({ limitBytes: 32000, components: { assignment: 18017 } });
    expect(first.context!.totalBytes).toBeLessThan(32000);
    expect(first.context!.artifacts[0]).toMatchObject({
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      contentBytes: Buffer.byteLength(artifactText),
    });
    expect(first.receipt.review).toMatchObject({
      snapshot: {
        artifacts: [{ ...artifact, contentBase64: Buffer.from(artifactText).toString('base64') }],
      },
    });
    expect(first.receipt.routingAudit).toMatchObject({
      role: 'planner',
      policyId: policy.policyId,
    });
    await vi.waitFor(
      () =>
        expect(
          service.read(authority, input.requestId).status,
          readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
            .split('\n')
            .filter((line) => line.includes('"level":40') || line.includes('"level":50'))
            .slice(-10)
            .join('\n'),
        ).toBe('completed'),
      { timeout: 5000 },
    );
    const planned = service.read(authority, input.requestId);
    expect(planned.receipt.allowanceState).toBe('charged');
    service.receipts.modelPolicies.save(authority.leadSessionId, {
      requestId: crypto.randomUUID(),
      expectedRevision: savedModels.revision + 1,
      policy: savedModels.policy,
    });
    expect(planned.contributions[0]).toMatchObject({
      role: 'planner',
      profileId: 'planner',
      text: 'Reviewed the selected design.',
    });
    expect(JSON.stringify(planned)).not.toContain('DO_NOT_LEAK');
    const sent = JSON.stringify(native.requests.filter((r) => r.method === 'turn/start')[0].params);
    expect(sent).toContain(artifact.artifactId);
    expect(sent).toContain('Pinned evidence 界🙂');
    expect(sent).toContain('Synthetic design requirement');
    const discussion = h.events.collaborationConversation.view(policy.collaborationId);
    expect(discussion.messages.find((message) => message.text === input.assignment)).toMatchObject({
      author: 'operator',
      source: null,
      origin: { sessionId: authority.leadSessionId, requestId: input.requestId },
    });
    for (let index = 0; index < 51; index++)
      h.events.collaborationConversation.acceptMessage(policy.collaborationId, {
        requestId: crypto.randomUUID(),
        expectedMembershipRevision: discussion.membershipRevision,
        expectedPolicySequence: discussion.policySequence,
        text: `Later discussion ${index}`,
        responders: { kind: 'selected', sessionIds: [first.receipt.sessionId!] },
        snapshot: null,
      });
    expect(
      h.events.collaborationConversation
        .view(policy.collaborationId)
        .messages.some((message) => message.messageId === planned.contributions[0].messageId),
    ).toBe(false);
    expect(service.read(authority, input.requestId).contributions).toEqual(planned.contributions);
    const repeated = await service.consult(authority, policy.policyId, input, approveAdmission);
    expect(repeated.receipt.sessionId).toBe(first.receipt.sessionId);
    expect(native.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    const reviewed = {
      ...input,
      requestId: crypto.randomUUID(),
      role: 'plan-reviewer',
      assignment: 'Review the plan independently.',
      reviewOf: input.requestId,
      messageIds: [],
      artifacts: [],
    };
    const second = await service.consult(authority, policy.policyId, reviewed, approveAdmission);
    expect(second.receipt.sessionId).not.toBe(first.receipt.sessionId);
    expect(second.independence).toMatchObject({ independent: true, differentFamily: false });
    await vi.waitFor(
      () => expect(service.read(authority, reviewed.requestId).status).toBe('completed'),
      { timeout: 5000 },
    );
    expect(native.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    const starts = native.requests.filter((r) => r.method === 'turn/start');
    expect(JSON.stringify(starts[1].params)).toContain('Reviewed the selected design.');
    expect(JSON.stringify(starts[1].params)).not.toContain('Synthetic design requirement');
    expect(
      h.events.getSession(first.receipt.sessionId!)?.agentContext?.context.fullMarkdown,
    ).toContain('Synthetic project context for specialists.');
    native.holdTurn(3);
    const held = { ...input, requestId: crypto.randomUUID(), messageIds: [] };
    await service.consult(authority, policy.policyId, held, approveAdmission);
    await vi.waitFor(
      () =>
        expect(
          native.requests.filter((r) => r.method === 'turn/start'),
          JSON.stringify(service.read(authority, held.requestId)) +
            readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
              .split('\n')
              .slice(-10)
              .join('\n'),
        ).toHaveLength(3),
      { timeout: 5000 },
    );
    await vi.waitFor(() => native.streamTurn(3, 'Partial specialist reply'));
    await service.stop(authority, held.requestId);
    expect(service.read(authority, held.requestId)).toMatchObject({
      status: 'stopped',
      terminal: false,
    });
    await service.stop(authority, held.requestId);
    expect(native.requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
    native.finishTurn(3, 'completed');
    await vi.waitFor(() => expect(service.read(authority, held.requestId).terminal).toBe(true));

    const { ApplicationCollaborationMessaging } =
      await import('../collaboration-application-messaging.js');
    const send = ApplicationCollaborationMessaging.prototype.send;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = vi
      .spyOn(ApplicationCollaborationMessaging.prototype, 'send')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof ApplicationCollaborationMessaging>,
        ...args
      ) {
        await released;
        return send.apply(this, args);
      });
    const cancelled = { ...input, requestId: crypto.randomUUID(), messageIds: [] };
    const preparing = service.consult(authority, policy.policyId, cancelled, approveAdmission);
    try {
      await vi.waitFor(
        () =>
          expect(
            gate,
            JSON.stringify(service.read(authority, cancelled.requestId).receipt),
          ).toHaveBeenCalledOnce(),
        { timeout: 10000 },
      );
      await service.stop(authority, cancelled.requestId);
    } finally {
      release();
    }
    expect((await preparing).status).toBe('stopped');
    expect(native.requests.filter((r) => r.method === 'turn/start')).toHaveLength(3);
    gate.mockRestore();

    const { registry } = await import('../chat.js');
    for (const entry of registry.entries(true)) registry.abort(entry[0]);
    native.restore();
    await journey.restartApplication();
    const reopened = await journey.getApplicationUiJourney();
    const recoveredAuth = (
      await import('../agent-library-transport.js')
    ).captureAgentLibraryAuthorization(reopened.clientId);
    authority = {
      ...authority,
      operatorConnectionId: reopened.clientId,
      auth: recoveredAuth.auth,
      assertCurrent: () => recoveredAuth.assertCurrent(),
    };
    (await import('../auth.js')).setAuthRevocationStore(reopened.events);
    service = (await import('../specialist-consultation-runtime.js')).getSpecialistConsultations();
    native = await (
      await import('./fixtures/symposium-recording-runtime.js')
    ).recordApplicationMessagingRuntime(reopened.events);
    expect(service.read(authority, input.requestId)).toMatchObject({
      status: 'completed',
      contributions: planned.contributions,
    });
    expect(
      (await service.consult(authority, policy.policyId, input, approveAdmission)).status,
    ).toBe('completed');
    expect(native.requests).toEqual([]);
    service.revoke(authority, policy.policyId);
    await expect(
      service.consult(authority, policy.policyId, { ...input, requestId: crypto.randomUUID() }),
    ).rejects.toThrow(/revoked/);
    expect(service.read(authority, input.requestId).status).toBe('completed');
  } finally {
    const { registry } = await import('../chat.js');
    for (const entry of registry.entries(true)) registry.abort(entry[0]);
    native.restore();
  }
}, 60000);

it('recovers a lost join response using the original shared owner without allocating a replacement', async () => {
  const h = await journey.getApplicationUiJourney();
  const { getSpecialistConsultations } = await import('../specialist-consultation-runtime.js');
  const captured = (await import('../agent-library-transport.js')).captureAgentLibraryAuthorization(
    h.clientId,
  );
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const authority = {
    leadSessionId: 'existing-chat',
    operatorConnectionId: h.clientId,
    auth: captured.auth,
    signal: new AbortController().signal,
    assertCurrent: () => captured.assertCurrent(),
  };
  const service = getSpecialistConsultations();
  const catalog = await service.catalog(authority);
  const policy = await service.authorize(
    authority,
    {
      requestId: crypto.randomUUID(),
      repository: 'example/acceptance',
      connectionId: catalog.repositories[0].connectionId,
      maxConsultations: 3,
      durationMinutes: 1,
      routes: [
        {
          role: 'plan-reviewer',
          accountId: 'offline-personal',
          model: 'fixture-model',
          reasoningEffort: 'low',
          runOn: 'local',
          targetId: 'offline-observation',
        },
      ],
    },
    async () => true,
  );
  const { OrdinaryCollaborationJoining } = await import('../collaboration-joining-owner.js');
  const confirm = OrdinaryCollaborationJoining.prototype.confirm;
  let originalSessionId: string | null = null;
  const lost = vi
    .spyOn(OrdinaryCollaborationJoining.prototype, 'confirm')
    .mockImplementationOnce(async function (
      this: InstanceType<typeof OrdinaryCollaborationJoining>,
      ...args
    ) {
      const result = await confirm.apply(this, args);
      originalSessionId = result.sessionId;
      throw Error('Synthetic response loss after durable joining');
    });
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  const native = await recordApplicationMessagingRuntime(h.events);
  try {
    const input = {
      requestId: crypto.randomUUID(),
      role: 'plan-reviewer',
      assignment: 'Investigate this bounded question.',
      messageIds: [],
      artifacts: [],
    };
    const interrupted = await service.consult(authority, policy.policyId, input, approveAdmission);
    expect(interrupted.status).toBe('uncertain');
    expect(
      lost,
      readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('specialist-consultation'))
        .slice(-3)
        .join('\n'),
    ).toHaveBeenCalledOnce();
    expect(originalSessionId).toBeTruthy();
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(0);
    lost.mockRestore();
    const recovered = await service.recover(authority, input.requestId, approveAdmission);
    expect(recovered.receipt.sessionId).toBe(originalSessionId);
    expect(recovered.receipt.workspaceId).toBe(interrupted.receipt.workspaceId);
    await vi.waitFor(
      () => expect(service.read(authority, input.requestId).status).toBe('completed'),
      { timeout: 5000 },
    );
    await service.recover(authority, input.requestId, approveAdmission);
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    const elapsedTime: { clock?: { mockRestore(): void } } = {};
    expect(authority.auth.expiresAt).toBeGreaterThan(policy.expiresAt + 1);
    const { ApplicationCollaborationMessaging } =
      await import('../collaboration-application-messaging.js');
    const send = ApplicationCollaborationMessaging.prototype.send;
    const expireBeforeAdmission = vi
      .spyOn(ApplicationCollaborationMessaging.prototype, 'send')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof ApplicationCollaborationMessaging>,
        ...args
      ) {
        await Promise.resolve();
        const now = Date.now;
        const elapsed = policy.expiresAt - now() + 1;
        elapsedTime.clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
        return send.apply(this, args);
      });
    try {
      const expiring = {
        ...input,
        requestId: crypto.randomUUID(),
      };
      const refused = await service.consult(authority, policy.policyId, expiring, approveAdmission);
      expect(elapsedTime.clock).toBeDefined();
      expect(refused.status).toBe('uncertain');
      expect(refused.receipt.allowanceState).toBe('released');
      expect(
        h.events.collaborationConversation.getMessageForRequest(
          policy.collaborationId,
          refused.receipt.messageInput,
        ),
      ).toBeNull();
      expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      elapsedTime.clock?.mockRestore();
      expireBeforeAdmission.mockRestore();
    }
    let providerFenceReached = false;
    const wrapFinalFence = vi
      .spyOn(ApplicationCollaborationMessaging.prototype, 'send')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof ApplicationCollaborationMessaging>,
        ...args
      ) {
        // Inject elapsed time at the actual ordinary provider fence, retaining
        // the original app port, admission, context and native execution owners.
        const port = Reflect.get(
          this,
          'port',
        ) as import('../session-prompt-dispatch.js').OrdinarySessionPromptPort;
        const deliver = port.deliverOrdinary;
        const wrapped = vi
          .spyOn(port, 'deliverOrdinary')
          .mockImplementationOnce((prompt, signal, current) => {
            const lifecycle = prompt.turnLifecycle!;
            return deliver(
              {
                ...prompt,
                turnLifecycle: {
                  ...lifecycle,
                  beforeDispatch: (commandId) => {
                    providerFenceReached = true;
                    const now = Date.now;
                    const elapsed = policy.expiresAt - now() + 1;
                    elapsedTime.clock = vi
                      .spyOn(Date, 'now')
                      .mockImplementation(() => now() + elapsed);
                    lifecycle.beforeDispatch(commandId);
                  },
                },
              },
              signal,
              current,
            );
          });
        try {
          return await send.apply(this, args);
        } finally {
          wrapped.mockRestore();
        }
      });
    try {
      const finalFence = await service.consult(
        authority,
        policy.policyId,
        {
          ...input,
          requestId: crypto.randomUUID(),
        },
        approveAdmission,
      );
      const { getCodexConversationStore } = await import('../codex-chat-session.js');
      await vi.waitFor(
        () =>
          expect(
            providerFenceReached,
            JSON.stringify(finalFence.receipt.diagnostic) +
              readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
                .split('\n')
                .filter((line) => line.includes('"level":40') || line.includes('"level":50'))
                .slice(-5)
                .join('\n'),
          ).toBe(true),
        { timeout: 5000 },
      );
      await vi.waitFor(
        () => {
          const sessionId = finalFence.receipt.sessionId!;
          const commandId = service.read(authority, finalFence.receipt.requestId).deliveries[0]
            .commandId!;
          expect(
            getCodexConversationStore().assertUndispatchedCommand(
              sessionId,
              h.events.getSession(sessionId)!.accountBinding!,
              commandId,
            ),
          ).toMatchObject({ status: 'failed' });
        },
        { timeout: 5000 },
      );
      expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      elapsedTime.clock?.mockRestore();
      wrapFinalFence.mockRestore();
    }
  } finally {
    lost.mockRestore();
    const { registry } = await import('../chat.js');
    for (const entry of registry.entries(true)) registry.abort(entry[0]);
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle(), { timeout: 5000 });
    native.restore();
  }
}, 60000);

it('does not redirect a retained policy when its lead moves to another shared conversation', async () => {
  const { h, service, authority, input, approve } = await authorizationFixture();
  const original = await service.authorize(authority, input, approve);
  const membership = h.events.getSessionCollaboration(original.collaborationId)!;
  h.events.setSessionCollaboration(original.collaborationId, {
    expectedRevision: membership.revision,
    participantSessionIds: membership.participantSessionIds.filter(
      (id) => id !== authority.leadSessionId,
    ),
  });
  const replacementGroup = crypto.randomUUID();
  h.events.collaborationConversation.begin(replacementGroup, {
    requestId: crypto.randomUUID(),
    sessionId: authority.leadSessionId,
  });
  const replay = await service.authorize(authority, input, approve).then(
    (policy) => ({ policy }),
    (error: unknown) => ({ error }),
  );
  expect(service.receipts.policy(authority.leadSessionId, original.policyId)).toEqual(original);
  expect(approve).toHaveBeenCalledOnce();
  if ('error' in replay)
    expect(replay.error).toMatchObject({ message: expect.stringContaining('Agents sharing') });
  else expect(replay.policy).toEqual(original);
});
