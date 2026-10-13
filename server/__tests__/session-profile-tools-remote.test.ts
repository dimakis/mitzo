import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
const mocks = vi.hoisted(() => ({ request: vi.fn(), assertCurrent: vi.fn(), capture: vi.fn() }));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerClient: { request: mocks.request },
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: mocks.capture,
}));
import { sessionCredentialTools } from '../session-credential-tools.js';
const definition = {
  name: 'Trace',
  role: 'agent',
  instructions: 'Diagnose',
  expectedOutput: 'Diagnosis',
  acceptanceCriteria: ['Evidence'],
  modelPolicyRole: 'agent',
};
const registries: SessionRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  vi.resetAllMocks();
});
function setup() {
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
    auth,
    session,
    registry,
    tools: sessionCredentialTools('chat', session, registry),
    signal: new AbortController().signal,
    call: { turnId: 'turn', callId: 'call' },
  };
}
it('creates a draft through the retained catalog owner with middleware authentication and host-bound identities', async () => {
  const { auth, tools, signal, call } = setup();
  mocks.request.mockResolvedValue({ status: 200, body: { proposalId: 'draft' } });
  expect(
    (await tools.execute('SymposiumProposeProfile', { definition }, signal, call))?.isError,
  ).toBe(false);
  expect(mocks.capture).toHaveBeenCalledWith('verified-client');
  const request = mocks.request.mock.calls[0][0];
  expect(request).toMatchObject({
    operation: 'proposal.create',
    authorization: auth,
    body: { sessionId: 'chat', definition },
  });
  expect(request.body.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await tools.execute(
        'SymposiumProposeProfile',
        { definition, sessionId: 'forged' },
        signal,
        call,
      )
    )?.isError,
  ).toBe(true);
  expect((await tools.execute('SymposiumProposeProfile', { definition }, signal))?.isError).toBe(
    true,
  );
  expect(mocks.request).toHaveBeenCalledTimes(1);
  mocks.assertCurrent.mockImplementation(() => {
    throw Error('Revoked');
  });
  expect(
    (await tools.execute('SymposiumProposeProfile', { definition }, signal, call))?.isError,
  ).toBe(true);
});
it('resolves a latest profile to an exact verified revision before reading its definition', async () => {
  const { tools, signal, call } = setup();
  mocks.request
    .mockResolvedValueOnce({
      status: 200,
      body: [
        { profileId: 'trace', revision: 1 },
        { profileId: 'trace', revision: 2 },
      ],
    })
    .mockResolvedValueOnce({ status: 200, body: { profileId: 'trace', revision: 2, definition } });
  const result = await tools.execute(
    'SymposiumReadProfiles',
    { action: 'get', profileId: 'trace' },
    signal,
    call,
  );
  expect(result?.isError).toBe(false);
  expect(mocks.request.mock.calls.map(([request]) => request.operation)).toEqual([
    'profile.list',
    'profile.read',
  ]);
  expect(mocks.request.mock.calls[1][0]).toMatchObject({ resourceId: 'trace', revision: '2' });
});
it('rejects revoked owners, cancellations and skill ceilings before dispatch', async () => {
  const { tools, signal, call, session } = setup();
  session.activeSkillPolicy = new Set(['Read']);
  expect(
    (await tools.execute('SymposiumProposeProfile', { definition }, signal, call))?.isError,
  ).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
  session.activeSkillPolicy = null;
  session.abortController.abort();
  expect(
    (await tools.execute('SymposiumReadProfiles', { action: 'list' }, signal, call))?.isError,
  ).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
});

it('refuses an in-flight result when the session moves to another operator connection', async () => {
  const { tools, signal, call, session } = setup();
  mocks.request.mockImplementation(async () => {
    session.ownerConnectionId = 'replacement';
    return { status: 200, body: { proposalId: 'draft' } };
  });
  const result = await tools.execute('SymposiumProposeProfile', { definition }, signal, call);
  expect(result?.isError).toBe(true);
  expect(result?.content).toMatch(/operator changed/i);
});
