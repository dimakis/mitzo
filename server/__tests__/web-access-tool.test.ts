import { beforeEach, describe, expect, it, vi } from 'vitest';
const approve = vi.hoisted(() => vi.fn());
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => approve,
}));
vi.mock('../public-web-fetch.js', () => ({ fetchPublicPage: vi.fn().mockResolvedValue('page') }));
import { createWebAccessTool } from '../web-access-tool.js';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
describe('shared web access tool wiring', () => {
  beforeEach(() => approve.mockReset());
  function fixture(mode = 'agent') {
    const session = {
      clientId: 'owner',
      sessionId: 'conversation',
      mode,
      activeSkillPolicy: null,
      accountBinding: { accountId: 'a', provider: 'openai', model: 'm', profileRevision: '1' },
    } as unknown as ManagedSession;
    const registry = {
      findBySessionId: () => ({ clientId: 'owner', session }),
      get: () => session,
    } as unknown as SessionRegistry;
    const search = vi.fn().mockResolvedValue('answer');
    return {
      session,
      registry,
      search,
      execute: createWebAccessTool('conversation', registry, search),
    };
  }
  it('offers session search consent without broadly caching the web access tool in Auto mode', async () => {
    const f = fixture('auto');
    const input = { operation: 'search', query: 'Revenue', reason: 'Check guidance' };
    approve.mockResolvedValue({ behavior: 'allow', updatedInput: input });
    expect(await f.execute(input, new AbortController().signal)).toMatchObject({ isError: false });
    expect(approve.mock.calls[0][2]).toMatchObject({
      forcePrompt: true,
      allowSessionGrant: false,
      approvalScope: 'session',
      rememberSessionGrant: false,
    });
  });
  it('passes the owning conversation and controller tool-operation ID to search', async () => {
    const f = fixture();
    const input = { operation: 'search', query: 'Revenue', reason: 'Check guidance' };
    approve.mockResolvedValue({ behavior: 'allow', updatedInput: input });
    await f.execute(input, new AbortController().signal);
    expect(f.search).toHaveBeenCalledWith('Revenue', expect.any(AbortSignal), {
      parentSessionId: 'conversation',
      operationId: approve.mock.calls[0][2].toolUseID,
    });
  });
  it('remembers only searches across tool recreation until the account or model changes', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    approve.mockImplementation(async (_name, input) => ({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_permanent',
    }));
    await f.execute({ operation: 'search', query: 'First', reason: 'Research' }, signal);
    const recreated = createWebAccessTool('conversation', f.registry, f.search);
    await recreated({ operation: 'search', query: 'Second', reason: 'Research' }, signal);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(f.search).toHaveBeenCalledTimes(2);
    const firstExecution = f.search.mock.calls[0][2];
    const secondExecution = f.search.mock.calls[1][2];
    expect(firstExecution).toEqual({
      parentSessionId: 'conversation',
      operationId: approve.mock.calls[0][2].toolUseID,
    });
    expect(secondExecution).toEqual({
      parentSessionId: 'conversation',
      operationId: expect.any(String),
    });
    expect(secondExecution.operationId).not.toBe(firstExecution.operationId);
    await recreated({ operation: 'fetch', url: 'https://example.com', reason: 'Read' }, signal);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls.at(-1)?.[2]).toMatchObject({ approvalScope: 'request' });
    f.session.model = 'other-model';
    await recreated({ operation: 'search', query: 'Third', reason: 'Research' }, signal);
    expect(approve).toHaveBeenCalledTimes(3);
    f.session.accountBinding!.accountId = 'other-account';
    await recreated({ operation: 'search', query: 'Fourth', reason: 'Research' }, signal);
    expect(approve).toHaveBeenCalledTimes(4);
  });
  it('allow once asks again for the next search', async () => {
    const f = fixture();
    approve.mockImplementation(async (_name, input) => ({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    }));
    for (const query of ['First', 'Second'])
      await f.execute(
        { operation: 'search', query, reason: 'Research' },
        new AbortController().signal,
      );
    expect(approve).toHaveBeenCalledTimes(2);
  });
  it('does not expose search in Ask mode', async () => {
    const f = fixture('ask');
    expect(
      await f.execute(
        { operation: 'search', query: 'q', reason: 'why' },
        new AbortController().signal,
      ),
    ).toMatchObject({ isError: true });
    expect(approve).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
  });
  it('rejects an account changed while approval is pending', async () => {
    const f = fixture();
    const input = { operation: 'search', query: 'q', reason: 'why' };
    approve.mockImplementation(async () => {
      f.session.accountBinding!.accountId = 'other';
      return { behavior: 'allow', updatedInput: input };
    });
    expect(await f.execute(input, new AbortController().signal)).toMatchObject({ isError: true });
    expect(f.search).not.toHaveBeenCalled();
  });
  it('resolves legacy SDK conversation identity when the tool is called, after init', async () => {
    const f = fixture();
    let conversationId = '';
    const registry = {
      get: () => f.session,
      findBySessionId: (id: string) =>
        id === 'conversation' ? { clientId: 'owner', session: f.session } : null,
    } as unknown as SessionRegistry;
    const execute = createWebAccessTool(() => conversationId, registry, f.search);
    conversationId = 'conversation';
    const input = { operation: 'search', query: 'q', reason: 'why' };
    approve.mockResolvedValue({ behavior: 'allow', updatedInput: input });
    expect(await execute(input, new AbortController().signal)).toMatchObject({ isError: false });
  });
});

it('routes exact URL access requests through the shared session approval tool', async () => {
  const session = {
    mode: 'agent',
    activeSkillPolicy: null,
    accountBinding: { accountId: 'a', provider: 'openai', model: 'm', profileRevision: '1' },
  } as unknown as ManagedSession;
  const registry = {
    get: () => session,
    findBySessionId: () => ({ clientId: 'owner', session }),
  } as unknown as SessionRegistry;
  approve.mockImplementation(async (_name, input) => ({ behavior: 'allow', updatedInput: input }));
  const execute = createWebAccessTool('conversation', registry, vi.fn());
  expect(
    await execute(
      {
        operation: 'request_access',
        url: 'http://127.0.0.1:8123/',
        reason: 'Access my HA instance',
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: false });
  expect(approve.mock.calls.at(-1)?.[1]).toMatchObject({
    origin: 'http://127.0.0.1:8123',
    resolvedAddresses: ['127.0.0.1'],
  });
  expect(
    await execute(
      { operation: 'revoke_access', url: 'http://127.0.0.1:8123/', reason: 'Remove access' },
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: false });
});
