import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SessionRegistry } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { sessionProfileTools, profileToolDefinitions } from '../session-profile-tools.js';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import { revokeAuthSession } from '../auth.js';

const fixture = vi.hoisted(() => ({
  approve: vi.fn(async (_display: unknown) => true),
  consult: vi.fn(async (_authority: unknown, _policyId: string, _input: unknown) => ({
    status: 'running',
    receipt: { requestId: 'retained' },
  })),
  read: vi.fn(() => ({ status: 'completed', contributions: [{ text: 'Plan', role: 'planner' }] })),
  catalog: vi.fn(async () => ({ profiles: [] })),
}));
vi.mock('../specialist-consultation-runtime.js', () => ({
  getSpecialistConsultations: () => ({
    consult: fixture.consult,
    read: fixture.read,
    catalog: fixture.catalog,
    authorize: async (
      _a: unknown,
      _raw: unknown,
      approve: (value: unknown) => Promise<boolean>,
    ) => {
      const display = { accountId: 'approved-account', maxConsultations: 2 };
      return { approved: await approve(display) };
    },
  }),
}));
vi.mock('../permission-handler.js', () => ({
  buildPermissionHandler: () => async (_name: string, display: unknown, options: unknown) => {
    expect(options).toMatchObject({
      forcePrompt: true,
      approvalScope: 'request',
      allowSessionGrant: false,
    });
    const approved = await fixture.approve(display);
    return approved ? { behavior: 'allow', updatedInput: display } : { behavior: 'deny' };
  },
}));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.clearAllMocks();
});
function tools() {
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
  registry.register('viewer:lead', {
    sessionId: 'lead',
    mode: 'agent',
    ownerConnectionId: 'viewer',
    ownedLocalAuthSessionId: auth.id,
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    sessionAllowList: new Set(),
  });
  cleanup.push(bindAgentLibraryTransport('viewer', auth));
  const session = registry.get('viewer:lead')!;
  return {
    session,
    auth,
    tool: sessionProfileTools(
      'lead',
      session,
      registry,
      '',
      async () => {},
      () => {},
    ),
  };
}
const call = { turnId: 'turn', callId: 'call' };
const signal = () => new AbortController().signal;
it('exposes consultation on ordinary native, API and Claude lead routes', () => {
  expect(profileToolDefinitions.map((t) => t.name)).toContain('SymposiumConsult');
  expect(agentToolCatalog().find((t) => t.name === 'SymposiumConsult')?.routes).toEqual(
    expect.arrayContaining(['local-api', 'codex-owned-local', 'claude-sdk']),
  );
});
it('requires exact policy approval, then invokes consultation under the verified lead authority', async () => {
  const { tool } = tools();
  expect(
    (await tool.execute('SymposiumConsult', { operation: 'authorize' }, signal(), call))?.isError,
  ).toBe(false);
  expect(fixture.approve).toHaveBeenCalledOnce();
  expect(
    (
      await tool.execute(
        'SymposiumConsult',
        {
          operation: 'consult',
          requestId: randomUUID(),
          policyId: randomUUID(),
          role: 'planner',
          assignment: 'Plan',
        },
        signal(),
        call,
      )
    )?.isError,
  ).toBe(false);
  expect(fixture.consult.mock.calls[0][0]).toMatchObject({
    leadSessionId: 'lead',
    operatorConnectionId: 'viewer',
  });
});
it('preserves Ask, explicit tool selection, current login and cancellation fences', async () => {
  const { tool, session, auth } = tools();
  const input = {
    operation: 'consult',
    requestId: randomUUID(),
    policyId: randomUUID(),
    role: 'planner',
    assignment: 'Plan',
  };
  session.mode = 'ask';
  expect((await tool.execute('SymposiumConsult', input, signal(), call))?.isError).toBe(true);
  session.mode = 'agent';
  expect((await tool.execute('SymposiumConsult', input, signal()))?.isError).toBe(true);
  bindAgentToolSelection(session, { tools: [] } as never, 'codex-owned-local');
  expect(
    (await tool.execute('SymposiumConsult', { operation: 'catalog' }, signal(), call))?.isError,
  ).toBe(true);
  revokeAuthSession(auth);
  expect(
    (
      await tool.execute(
        'SymposiumConsult',
        { operation: 'read', requestId: randomUUID() },
        signal(),
        call,
      )
    )?.isError,
  ).toBe(true);
  const cancelled = new AbortController();
  cancelled.abort();
  expect((await tool.execute('SymposiumConsult', input, cancelled.signal, call))?.isError).toBe(
    true,
  );
  expect(fixture.consult).not.toHaveBeenCalled();
});

it('returns a useful independence refusal without exposing arbitrary upstream diagnostics', async () => {
  const { tool } = tools();
  const input = {
    operation: 'consult',
    requestId: randomUUID(),
    policyId: randomUUID(),
    role: 'reviewer',
    assignment: 'Review independently',
  };
  fixture.consult.mockRejectedValueOnce(
    Error('No eligible independent specialist route is authorized for this role'),
  );
  const refused = await tool.execute('SymposiumConsult', input, signal(), call);
  expect(refused?.isError).toBe(true);
  expect(JSON.parse(refused!.content)).toMatchObject({
    error: 'independent_route_unavailable',
    stage: 'consult',
  });
  fixture.consult.mockRejectedValueOnce(
    Error('Upstream private credential payload must stay internal'),
  );
  const failed = await tool.execute('SymposiumConsult', input, signal(), call);
  expect(failed?.content).not.toContain('private credential payload');
});

it('renews the original login after an awaited owner response', async () => {
  const { tool, auth } = tools();
  fixture.catalog.mockImplementationOnce(async () => {
    revokeAuthSession(auth);
    return { profiles: ['withheld-after-revocation'] } as never;
  });
  const result = await tool.execute('SymposiumConsult', { operation: 'catalog' }, signal(), call);
  expect(result?.isError).toBe(true);
  expect(result?.content).not.toContain('withheld-after-revocation');
});
