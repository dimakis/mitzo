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
    specialistPermissionMode: 'ask',
  });
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  let native = await recordApplicationMessagingRuntime(h.events);
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
    expect(planned.contributions[0]).toMatchObject({
      role: 'planner',
      profileId: 'planner',
      text: 'Reviewed the selected design.',
    });
    expect(JSON.stringify(planned)).not.toContain('DO_NOT_LEAK');
    const discussion = h.events.collaborationConversation.view(policy.collaborationId);
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
    await service.consult(authority, policy.policyId, held);
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
    const preparing = service.consult(authority, policy.policyId, cancelled);
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
    expect((await service.consult(authority, policy.policyId, input)).status).toBe('completed');
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
    const interrupted = await service.consult(authority, policy.policyId, input);
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
    const recovered = await service.recover(authority, input.requestId);
    expect(recovered.receipt.sessionId).toBe(originalSessionId);
    expect(recovered.receipt.workspaceId).toBe(interrupted.receipt.workspaceId);
    await vi.waitFor(
      () => expect(service.read(authority, input.requestId).status).toBe('completed'),
      { timeout: 5000 },
    );
    await service.recover(authority, input.requestId);
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
      const refused = await service.consult(authority, policy.policyId, expiring);
      expect(elapsedTime.clock).toBeDefined();
      expect(refused.status).toBe('uncertain');
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
      const finalFence = await service.consult(authority, policy.policyId, {
        ...input,
        requestId: crypto.randomUUID(),
      });
      const { getCodexConversationStore } = await import('../codex-chat-session.js');
      await vi.waitFor(() => expect(providerFenceReached).toBe(true), { timeout: 5000 });
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
