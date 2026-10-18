import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  capture: vi.fn(),
  assertCurrent: vi.fn(),
  local: vi.fn(),
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerClient: { request: mocks.request },
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: mocks.capture,
}));
vi.mock('../agent-task-runtime.js', () => ({ getAgentTasks: mocks.local }));
import { sessionAgentTaskTools } from '../session-agent-task-tools.js';
const definition = {
  name: 'Daily evidence',
  objective: '',
  profile: { profileId: 'trace', revision: 3, contentHash: 'a'.repeat(64) },
  execution: null,
  workspace: null,
  schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Dublin', state: 'paused' },
  notificationPolicy: 'results',
  outputPolicy: 'session',
};
const registries: SessionRegistry[] = [];
afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
  vi.resetAllMocks();
});
function setup(runtime = vi.fn(async () => {}), sync = vi.fn()) {
  const registry = new SessionRegistry();
  registries.push(registry);
  registry.register('verified-client:chat', {
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    sessionId: 'chat',
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const session = registry.get('verified-client:chat')!;
  const auth = { id: 'login', expiresAt: Date.now() + 10000 };
  mocks.capture.mockReturnValue({ auth, assertCurrent: mocks.assertCurrent });
  return {
    registry,
    session,
    auth,
    tools: sessionAgentTaskTools('chat', session, registry, '', runtime, sync),
    controller: new AbortController(),
    call: { turnId: 'turn', callId: 'call' },
    runtime,
    sync,
  };
}
it('forwards a reviewable exact-revision proposal through retained owner with host-bound identity and no task save', async () => {
  const { tools, controller, call, auth } = setup();
  mocks.request.mockResolvedValue({ status: 200, body: { proposalId: 'draft' } });
  const input = { taskId: 'daily', expectedRevision: 4, definition };
  const first = await tools.execute('AgentProposeTask', input, controller.signal, call);
  expect(first).toMatchObject({ isError: false });
  expect(JSON.parse(first!.content)).toEqual({
    proposalId: 'draft',
    status: 'awaiting_user_review',
    taskId: 'daily',
    expectedRevision: 4,
  });
  await tools.execute('AgentProposeTask', input, controller.signal, call);
  const requests = mocks.request.mock.calls.map(([request]) => request);
  expect(requests[0]).toMatchObject({
    operation: 'proposal.create',
    authorization: auth,
    body: { kind: 'task', sessionId: 'chat', ...input },
  });
  expect(requests[0].body.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  expect(requests[1].body.idempotencyKey).toBe(requests[0].body.idempotencyKey);
  await tools.execute('AgentProposeTask', input, controller.signal, { ...call, callId: 'another' });
  expect(mocks.request.mock.calls[2][0].body.idempotencyKey).not.toBe(
    requests[0].body.idempotencyKey,
  );
  expect(mocks.capture).toHaveBeenCalledWith('verified-client');
  expect(mocks.local).not.toHaveBeenCalled();
});
it('reads tasks using only closed agentTasks operations and validates the returned saved revision', async () => {
  const { tools, controller } = setup();
  mocks.request.mockResolvedValue({ status: 200, body: [] });
  expect(
    (await tools.execute('AgentReadTasks', { action: 'list' }, controller.signal))?.isError,
  ).toBe(false);
  expect(mocks.request.mock.calls[0][0].operation).toBe('agentTasks.list');
  expect(
    JSON.parse(
      (await tools.execute('AgentReadTasks', { action: 'list' }, controller.signal))!.content,
    ),
  ).toEqual({ tasks: [], nextOffset: null });
  mocks.request.mockClear();
  mocks.request.mockResolvedValue({
    status: 200,
    body: {
      taskId: 'daily',
      revision: 5,
      definition,
      configuration: { state: 'draft' },
      deleted: false,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    },
  });
  const read = await tools.execute(
    'AgentReadTasks',
    { action: 'get', taskId: 'daily' },
    controller.signal,
  );
  expect(JSON.parse(read!.content)).toMatchObject({ taskId: 'daily', revision: 5, definition });
  expect(mocks.request.mock.calls[0][0]).toMatchObject({
    operation: 'agentTasks.read',
    resourceId: 'daily',
  });
});
it('rejects forged input, missing verified call identity, enabled schedules and invalid read shapes before effects', async () => {
  const { tools, controller, call } = setup();
  for (const input of [
    { taskId: 'daily', expectedRevision: 0, definition, owner: 'other' },
    { taskId: 'daily', definition },
    {
      taskId: 'daily',
      expectedRevision: 0,
      definition: { ...definition, schedule: { ...definition.schedule, state: 'enabled' } },
    },
  ])
    expect((await tools.execute('AgentProposeTask', input, controller.signal, call))?.isError).toBe(
      true,
    );
  expect(
    (
      await tools.execute(
        'AgentProposeTask',
        { taskId: 'daily', expectedRevision: 0, definition },
        controller.signal,
      )
    )?.isError,
  ).toBe(true);
  for (const input of [{ action: 'get' }, { action: 'list', taskId: 'daily' }])
    expect((await tools.execute('AgentReadTasks', input, controller.signal))?.isError).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
});
it('requires current interactive operator, session, skill and runtime authority before effects', async () => {
  const { tools, controller, registry, session, runtime } = setup();
  const read = () => tools.execute('AgentReadTasks', { action: 'list' }, controller.signal);
  mocks.capture.mockImplementationOnce(() => {
    throw Error('No operator');
  });
  expect((await read())?.isError).toBe(true);
  session.activeSkillPolicy = new Set(['Read']);
  expect((await read())?.isError).toBe(true);
  session.activeSkillPolicy = null;
  runtime.mockRejectedValueOnce(Error('Runtime replaced'));
  expect((await read())?.isError).toBe(true);
  registry.remove('verified-client:chat');
  expect((await read())?.isError).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
});
it.each(['cancel', 'session', 'skill', 'operator', 'runtime'])(
  'rechecks %s after runtime awaits before dispatch',
  async (change) => {
    const runtime = vi.fn(async () => {});
    const { tools, controller, session, sync } = setup(runtime);
    runtime.mockImplementationOnce(async () => {
      if (change === 'cancel') controller.abort();
      if (change === 'session') session.abortController.abort();
      if (change === 'skill') session.activeSkillPolicy = new Set(['Read']);
      if (change === 'operator')
        mocks.assertCurrent.mockImplementation(() => {
          throw Error('Revoked');
        });
      if (change === 'runtime')
        sync.mockImplementation(() => {
          throw Error('Replaced');
        });
    });
    const result = await tools.execute('AgentReadTasks', { action: 'list' }, controller.signal);
    expect(result?.isError).toBe(true);
    expect(mocks.request).not.toHaveBeenCalled();
  },
);
it.each(['cancel', 'skill', 'operator', 'connection', 'runtime'])(
  'rejects %s after awaited owner work without local fallback',
  async (change) => {
    const { tools, controller, session, runtime } = setup();
    mocks.request.mockImplementation(async () => {
      if (change === 'cancel') controller.abort();
      if (change === 'skill') session.activeSkillPolicy = new Set(['Read']);
      if (change === 'operator')
        mocks.assertCurrent.mockImplementation(() => {
          throw Error('Revoked');
        });
      if (change === 'connection') session.ownerConnectionId = 'replacement';
      if (change === 'runtime') runtime.mockRejectedValue(Error('Replaced'));
      return { status: 200, body: [] };
    });
    expect(
      (await tools.execute('AgentReadTasks', { action: 'list' }, controller.signal))?.isError,
    ).toBe(true);
    expect(mocks.local).not.toHaveBeenCalled();
  },
);
it('preserves owner failure instead of falling back to a controller store', async () => {
  const { tools, controller } = setup();
  mocks.request.mockRejectedValue(Error('Owner unavailable'));
  expect(
    (await tools.execute('AgentReadTasks', { action: 'list' }, controller.signal))?.isError,
  ).toBe(true);
  expect(mocks.local).not.toHaveBeenCalled();
});

it('refuses task capability without a qualified current runtime owner', async () => {
  const { registry, session, controller } = setup();
  const tools = sessionAgentTaskTools('chat', session, registry, '');
  expect(
    (await tools.execute('AgentReadTasks', { action: 'list' }, controller.signal))?.isError,
  ).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
});

it('advertises task inputs as top-level object schemas for ordinary provider function tools', async () => {
  const { agentTaskToolDefinitions } = await import('../session-agent-task-tools.js');
  for (const tool of agentTaskToolDefinitions)
    expect(tool.input_schema).toMatchObject({ type: 'object' });
});
