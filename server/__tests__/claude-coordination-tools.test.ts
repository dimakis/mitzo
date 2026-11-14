import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry } from '@mitzo/harness';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import { ordinarySdkConnectionHelperTools } from '../ordinary-sdk-helper-registration.js';
import {
  assertAgentToolRoute,
  bindAgentToolSelection,
  projectAgentHelperSupport,
} from '../agent-tool-selection.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { SessionPromptService } from '../session-prompt-service.js';
import { SessionPromptStore } from '../session-prompt-store.js';
import { initializeSessionLaunches, closeSessionLaunches } from '../session-launch-controller.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
  type SdkCallbackState,
} from '../ordinary-local-vertex-sdk-query.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
  getSessionInfo: vi.fn(async () => ({ sessionId: 'sdk-history', cwd: process.cwd() })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'retained-input' }]),
}));

const runtime = vi.hoisted(() => ({
  service: undefined as SessionPromptService | undefined,
  approve: vi.fn(),
}));
vi.mock('../session-prompt-runtime.js', () => ({ getSessionPrompts: () => runtime.service! }));
vi.mock('../permission-handler.js', () => ({ buildPermissionHandler: () => runtime.approve }));
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const names = [
  'SymposiumConsult',
  'SymposiumReadProfiles',
  'SymposiumProposeProfile',
  'StartSession',
  'AgentCommunication',
  'SchedulePrompt',
  'SessionTimers',
  'SendSessionMessage',
];
const definition = {
  name: 'Coordinator',
  role: 'agent',
  instructions: 'Coordinate bounded work.',
  expectedOutput: 'Retained receipts',
  acceptanceCriteria: ['Report actual state'],
  modelPolicyRole: 'agent',
};

async function fixture(explicit = true) {
  const root = mkdtempSync(join(tmpdir(), 'claude-coordination-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('REPO_PATH', root);
  mkdirSync(join(root, '.mitzo'));
  const profiles = new SymposiumProfileStore(join(root, '.mitzo/events.db'));
  profiles.save('user', {
    profileId: 'coordinator',
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    definition,
  });
  profiles.close();
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  registry.register('viewer:source', {
    sessionId: 'source',
    ownerConnectionId: 'viewer',
    mode: 'agent',
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    sessionAllowList: new Set(),
  });
  const session = registry.get('viewer:source')!;
  cleanup.push(
    bindAgentLibraryTransport('viewer', { id: randomUUID(), expiresAt: Date.now() + 60000 }),
  );
  const port = {
    authorized: vi.fn(() => true),
    inspect: vi.fn(async () => ({ busy: true })),
    deliver: vi.fn(async () => {}),
    receipt: vi.fn(() => 'absent' as 'absent' | 'accepted' | 'uncertain'),
    close() {},
  };
  const store = new SessionPromptStore(join(root, 'prompts.db'));
  const service = new SessionPromptService(store, port);
  runtime.service = service;
  cleanup.push(
    () => store.close(),
    () => service.close(),
  );
  runtime.approve.mockImplementation(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: input,
  }));
  const launches = initializeSessionLaunches(join(root, 'launches.db'), () => {});
  cleanup.push(closeSessionLaunches);
  const selected = {
    ...definition,
    ...(explicit ? { tools: names.map((name) => ({ id: `mitzo:${name}`, version: 1 })) } : {}),
  };
  bindAgentToolSelection(session, selected, 'claude-sdk');
  const makeServer = (state?: Pick<SdkCallbackState, 'retired' | 'completing' | 'runCallback'>) =>
    createCredentialSdkServer(() => 'source', session, registry, {
      profilesOnly: true,
      runCallback: state?.runCallback,
      assertCurrent: async () => {
        if (state?.retired || state?.completing) throw Error('Completed SDK query retired');
      },
      assertCurrentSync() {
        if (state?.retired || state?.completing) throw Error('Completed SDK query retired');
      },
    });
  const connect = async (server = makeServer()) => {
    const client = new Client({ name: 'offline-coordination', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    cleanup.push(
      () => server.instance.close(),
      () => client.close(),
    );
    return async (name: string, input: Record<string, unknown>) => {
      const permission = credentialSdkPermission(
        `mcp__mitzo-connections__${name}`,
        input,
        'viewer:source',
        registry,
        session,
      );
      expect(permission?.behavior).toBe('allow');
      const result = await client.callTool({ name, arguments: input });
      const text = (result.content as Array<{ text: string }>)[0].text;
      return { ...result, value: result.isError ? text : JSON.parse(text) };
    };
  };
  return { session, registry, connect, makeServer, port, service, store, launches };
}

it('qualifies the coordination surface for explicit profiles and the ordinary callback fence', () => {
  expect(() =>
    assertAgentToolRoute(
      { ...definition, tools: names.map((name) => ({ id: `mitzo:${name}`, version: 1 })) },
      'claude-sdk',
    ),
  ).not.toThrow();
  for (const name of names)
    expect(ordinarySdkConnectionHelperTools).toContain(`mcp__mitzo-connections__${name}`);
});

it.each([false, true])(
  'executes saved-profile reads/proposals and ordinary reviewed creation through MCP (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    const call = await f.connect();
    expect(
      (await call('SymposiumReadProfiles', { action: 'get', profileId: 'coordinator' })).value,
    ).toMatchObject({ revision: 1, definition });
    const proposal = await call('SymposiumProposeProfile', { definition });
    expect(proposal).toMatchObject({ isError: false, value: { status: 'awaiting_user_review' } });
    const input = {
      requestId: randomUUID(),
      title: 'Bounded follow-up',
      prompt: 'Self-contained handover.',
    };
    const first = await call('StartSession', input);
    expect(first).toMatchObject({
      isError: false,
      value: { state: 'pending', childSessionId: null },
    });
    expect(first.value.handoverDownloadUrl).toContain(first.value.proposalId);
    const coldCall = await f.connect();
    expect((await coldCall('StartSession', input)).value).toEqual(first.value);
    expect(
      f.launches.launches.store.forRequest('source', 'user', input.requestId)?.childSessionId,
    ).toBeNull();
    f.session.activeSkillPolicy = new Set(['StartSession']);
    const rejected = await f.registry.get('viewer:source');
    expect(
      credentialSdkPermission(
        'mcp__mitzo-connections__StartSession',
        input,
        'viewer:source',
        f.registry,
        rejected!,
      ),
    ).toMatchObject({ behavior: 'deny' });
  },
);

it('uses the durable scheduler and exact receipts across MCP retries and reconnect without duplicate dispatch', async () => {
  const f = await fixture();
  let call = await f.connect();
  const input = {
    requestId: randomUUID(),
    prompt: 'Check the bounded task',
    intervalMinutes: 10,
    startImmediately: true,
  };
  const scheduled = await call('SchedulePrompt', input);
  expect(scheduled).toMatchObject({
    isError: false,
    value: { sessionId: 'source', status: 'active', revision: 1 },
  });
  const timer = scheduled.value;
  expect((await call('SchedulePrompt', input)).value.id).toBe(timer.id);
  const update = {
    operation: 'update',
    timerId: timer.id,
    expectedRevision: timer.revision,
    requestId: randomUUID(),
    prompt: 'Updated bounded check',
  };
  const changed = await call('SessionTimers', update);
  expect(changed).toMatchObject({ isError: false, value: { prompt: update.prompt, revision: 2 } });
  expect((await call('SessionTimers', { ...update, requestId: randomUUID() })).isError).toBe(true);
  const message = {
    requestId: randomUUID(),
    sessionId: 'recipient',
    text: 'Report completion.',
    workId: 'bounded-work',
  };
  const sent = await call('SendSessionMessage', message);
  expect(sent).toMatchObject({
    isError: false,
    value: { state: 'pending', senderSessionId: 'source', workId: message.workId },
  });
  await f.service.tick();
  expect(f.port.deliver).not.toHaveBeenCalled();
  call = await f.connect();
  expect((await call('SendSessionMessage', message)).value).toEqual(sent.value);
  const cancelled = await call('SessionTimers', {
    operation: 'cancel',
    timerId: timer.id,
    expectedRevision: changed.value.revision,
    requestId: randomUUID(),
  });
  expect(cancelled).toMatchObject({ isError: false, value: { status: 'cancelled' } });
  f.port.inspect.mockResolvedValue({ busy: false });
  f.port.deliver.mockRejectedValueOnce(Error('Synthetic response lost'));
  f.port.receipt.mockReturnValue('uncertain');
  await f.service.tick();
  expect(
    (await call('SessionTimers', { operation: 'delivery', deliveryId: sent.value.id })).value.state,
  ).toBe('uncertain');
  expect((await call('SendSessionMessage', message)).value.state).toBe('uncertain');
  f.port.receipt.mockReturnValue('accepted');
  await f.service.tick();
  expect(
    (await call('SessionTimers', { operation: 'delivery', deliveryId: sent.value.id })).value.state,
  ).toBe('accepted');
  expect(f.port.deliver).toHaveBeenCalledOnce();
  expect(f.store.get(timer.id)).toMatchObject({ status: 'cancelled', runCount: 0 });
});

it('projects exclusions and the exact SDK skill namespace without granting calls', async () => {
  const f = await fixture();
  f.session.activeSkillPolicy = new Set(['mcp__mitzo-connections__SessionTimers']);
  const supported = projectAgentHelperSupport(
    f.session,
    'claude-sdk',
    f.session.activeSkillPolicy,
  )!;
  expect(supported.find((tool) => tool.name === 'SessionTimers')?.state).toBe('supported');
  expect(supported.find((tool) => tool.name === 'SchedulePrompt')?.state).toBe('restricted');
});

it.each([false, true])(
  'retains callable coordination handlers on first, queued-successor and cold-continuation SDK queries (explicit=%s)',
  async (explicit) => {
    const f = await fixture(explicit);
    vi.mocked(query).mockImplementation(
      () => ({ close() {}, async *[Symbol.asyncIterator]() {} }) as never,
    );
    const create = (options: Options = {}) => {
      const controller = new AbortController();
      cleanup.push(() => controller.abort());
      return createOrdinaryLocalVertexSdkQuery({
        options: {
          sessionId: 'sdk-history',
          allowedTools: [...ordinarySdkConnectionHelperTools],
          ...options,
        },
        input: new AsyncQueue(),
        controller,
        lifetime: new SdkHookLifetime(),
        sdkSessionId: 'sdk-history',
        cwd: process.cwd(),
        authorize: async () => {},
        authorizeSync() {},
        adapt: (native) => native as never,
        settings: () => ({}),
        inputChanged() {},
        onUnsent: () => {
          throw Error('Unexpected input');
        },
        mcpServers: (state) => ({ 'mitzo-connections': f.makeServer(state) }),
      });
    };
    const currentServer = () =>
      vi.mocked(query).mock.calls.at(-1)![0].options!.mcpServers![
        'mitzo-connections'
      ] as ReturnType<typeof f.makeServer>;
    const first = create();
    const original = await f.connect(currentServer());
    expect((await original('SessionTimers', { operation: 'list' })).value).toEqual([]);
    await first.apply({} as never);
    await first.apply({} as never);
    const successor = await f.connect(currentServer());
    expect(
      (
        await successor('StartSession', {
          requestId: randomUUID(),
          title: 'Successor handoff',
          prompt: 'Self-contained follow-up.',
        })
      ).value.state,
    ).toBe('pending');
    expect(await original('SessionTimers', { operation: 'list' })).toMatchObject({
      isError: true,
      value: 'Completed SDK query retired',
    });
    create({ sessionId: undefined, resume: 'sdk-history' });
    const cold = await f.connect(currentServer());
    expect(
      (await cold('SymposiumReadProfiles', { action: 'get', profileId: 'coordinator' })).value,
    ).toMatchObject({ revision: 1 });
    expect(vi.mocked(query).mock.calls.at(-1)![0].options).toMatchObject({
      resume: 'sdk-history',
      allowedTools: [...ordinarySdkConnectionHelperTools],
    });
  },
);
