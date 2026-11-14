import { afterAll, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());

it('executes a bounded consultation through the SDK bridge to a terminal attributed contribution and retains its original receipt', async () => {
  const h = await journey.getApplicationUiJourney();
  const { getAgentLibrary } = await import('../agent-library-runtime.js');
  const { setAuthRevocationStore } = await import('../auth.js');
  setAuthRevocationStore(h.events);
  const library = getAgentLibrary();
  library.saveDraft('user', {
    profileId: 'sdk-planner',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'sdk-planner-draft',
    definition: {
      name: 'SDK planner',
      role: 'planner',
      instructions: 'Plan the bounded assignment.',
      expectedOutput: 'Attributed evidence',
      acceptanceCriteria: ['Cite selected context'],
      modelPolicyRole: 'planner',
    },
  });
  library.publish('user', {
    profileId: 'sdk-planner',
    expectedVersion: 1,
    idempotencyKey: 'sdk-planner-publish',
  });
  const view = await h.api.view(h.group);
  for (const policy of view.policies.filter((entry) => entry.readsFutureDiscussion))
    await h.api.setPolicy(h.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedRevision: policy.revision,
      sessionId: policy.sessionId,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  const native = await recordApplicationMessagingRuntime(h.events);
  const { SessionRegistry, resolvePending } = await import('@mitzo/harness');
  const registry = new SessionRegistry();
  registry.register(`${h.clientId}:existing-chat`, {
    sessionId: 'existing-chat',
    ownerConnectionId: h.clientId,
    mode: 'agent',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    transport: {
      isOpen: () => true,
      send: (event) => {
        if (event.type === 'permission_request')
          queueMicrotask(() =>
            resolvePending(event.permId as string, 'once', undefined, event.sessionId as string),
          );
      },
    },
  });
  const session = registry.get(`${h.clientId}:existing-chat`)!;
  const { bindAgentToolSelection } = await import('../agent-tool-selection.js');
  bindAgentToolSelection(
    session,
    { tools: [{ id: 'mitzo:SymposiumConsult', version: 1 }] } as never,
    'claude-sdk',
  );
  session.activeSkillPolicy = new Set(['mcp__mitzo-connections__SymposiumConsult']);
  const { createCredentialSdkServer } = await import('../credential-sdk-tools.js');
  const peers: Array<{ client: Client; server: ReturnType<typeof createCredentialSdkServer> }> = [];
  const connect = async () => {
    const server = createCredentialSdkServer(() => 'existing-chat', session, registry, {
      profilesOnly: true,
      assertCurrent: async () => {},
      assertCurrentSync() {},
    });
    const client = new Client({ name: 'offline-specialist-coordination', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    peers.push({ client, server });
    return async (input: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'SymposiumConsult', arguments: input });
      return {
        isError: result.isError,
        value: JSON.parse((result.content as Array<{ text: string }>)[0].text),
      };
    };
  };
  try {
    let call = await connect();
    const catalog = await call({ operation: 'catalog' });
    expect(catalog.isError).toBe(false);
    expect(catalog.value.profiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'planner' })]),
    );
    const authorization = {
      operation: 'authorize',
      requestId: crypto.randomUUID(),
      connectionId: catalog.value.repositories[0].connectionId,
      repository: 'example/acceptance',
      durationMinutes: 10,
      maxConsultations: 1,
      maxContextBytes: 32000,
      routes: [
        {
          role: 'planner',
          accountId: 'offline-personal',
          model: 'fixture-model',
          reasoningEffort: 'low',
          runOn: 'local',
          targetId: 'offline-observation',
        },
      ],
    };
    const policy = await call(authorization);
    expect(policy.isError).toBe(false);
    const input = {
      operation: 'consult',
      requestId: crypto.randomUUID(),
      policyId: policy.value.policyId,
      role: 'planner',
      assignment: 'Plan the bounded change.',
      messageIds: ['selected-source'],
    };
    const dispatched = await call(input);
    expect(dispatched.isError).toBe(false);
    expect(dispatched.value.receipt).toMatchObject({
      requestId: input.requestId,
      state: 'dispatched',
    });
    let completed: Awaited<ReturnType<typeof call>> | undefined;
    await vi.waitFor(
      async () => {
        completed = await call({ operation: 'read', requestId: input.requestId });
        expect(completed.value.status).toBe('completed');
      },
      { timeout: 5000 },
    );
    expect(completed!.value).toMatchObject({
      terminal: true,
      contributions: [
        expect.objectContaining({
          profileId: 'sdk-planner',
          revision: 1,
          role: 'planner',
          text: 'Reviewed the selected design.',
        }),
      ],
    });
    expect(JSON.stringify(completed)).not.toContain('DO_NOT_LEAK');
    call = await connect();
    expect((await call(input)).value).toEqual(completed!.value);
    expect((await call({ operation: 'recover', requestId: input.requestId })).value).toEqual(
      completed!.value,
    );
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    const rejected = await call({ ...input, requestId: crypto.randomUUID() });
    expect(rejected.isError).toBe(true);
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    const recoveryPolicy = await call({ ...authorization, requestId: crypto.randomUUID() });
    expect(recoveryPolicy.isError).toBe(false);
    const { OrdinaryCollaborationJoining } = await import('../collaboration-joining-owner.js');
    const confirm = OrdinaryCollaborationJoining.prototype.confirm;
    let originalSessionId: string | null = null;
    const lost = vi
      .spyOn(OrdinaryCollaborationJoining.prototype, 'confirm')
      .mockImplementationOnce(async function (
        this: InstanceType<typeof OrdinaryCollaborationJoining>,
        ...args
      ) {
        const joined = await confirm.apply(this, args);
        originalSessionId = joined.sessionId;
        throw Error('Synthetic private upstream detail after durable joining');
      });
    const interruptedInput = {
      ...input,
      requestId: crypto.randomUUID(),
      policyId: recoveryPolicy.value.policyId,
    };
    let interrupted;
    try {
      interrupted = await call(interruptedInput);
      expect(interrupted).toMatchObject({
        isError: true,
        value: {
          status: 'uncertain',
          terminal: false,
          receipt: { requestId: interruptedInput.requestId },
        },
      });
      expect(JSON.stringify(interrupted)).not.toContain('private upstream detail');
      expect(lost).toHaveBeenCalledOnce();
      expect(originalSessionId).toBeTruthy();
      expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      lost.mockRestore();
    }
    call = await connect();
    const recovered = await call({ operation: 'recover', requestId: interruptedInput.requestId });
    expect(recovered.value.receipt).toMatchObject({
      sessionId: originalSessionId,
      workspaceId: interrupted.value.receipt.workspaceId,
    });
    await vi.waitFor(
      async () =>
        expect(
          (await call({ operation: 'read', requestId: interruptedInput.requestId })).value,
        ).toMatchObject({ status: 'completed', terminal: true }),
      { timeout: 5000 },
    );
    expect(
      (await call({ operation: 'recover', requestId: interruptedInput.requestId })).value.status,
    ).toBe('completed');
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
  } finally {
    for (const { client, server } of peers.reverse()) {
      await client.close();
      await server.instance.close();
    }
    registry.dispose();
    const chat = await import('../chat.js');
    for (const [id] of chat.registry.entries(true)) chat.registry.abort(id);
    const { closeIdleRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => closeIdleRepositoryWorkspaces(), { timeout: 5000 });
    native.restore();
  }
}, 30000);
