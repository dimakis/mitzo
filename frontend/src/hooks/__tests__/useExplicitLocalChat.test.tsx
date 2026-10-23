// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useExplicitLocalChat } from '../useExplicitLocalChat';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { prepareLocalContinuationCommand } from '../../lib/explicit-local-chat';
import { sha256Hex } from '../../lib/browser-crypto';
import { setDefaultAccountModel } from '../../lib/account-preference';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
} from '@mitzo/protocol';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('starts fresh chat intent with code-owned Default Mitzo and preserves an explicit Builder link', () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json(localInventoryFixture()));
  const normal = renderHook(() => useExplicitLocalChat('fresh-default', undefined, null, false));
  expect(normal.result.current.intent.agentProfile).toEqual({
    kind: 'builtin',
    profileId: DEFAULT_MITZO_PROFILE_ID,
    revision: DEFAULT_MITZO_PROFILE_REVISION,
  });
  const search = new URLSearchParams({
    agentProfile: PROFILE_BUILDER_ID,
    profileRevision: String(PROFILE_BUILDER_REVISION),
    agentProfileKind: 'builtin',
  }).toString();
  const builder = renderHook(() =>
    useExplicitLocalChat('fresh-builder', undefined, null, false, search),
  );
  expect(builder.result.current.intent.agentProfile).toEqual({
    kind: 'builtin',
    profileId: PROFILE_BUILDER_ID,
    revision: PROFILE_BUILDER_REVISION,
  });
});

it.each([null, { profileId: 'removed-agent', revision: 9 }])(
  'preserves a retained explicit agent selection without substituting Default Mitzo: %j',
  (agentProfile) => {
    const saved = { ...createChatRuntimeSelection(), agentProfile };
    const { result } = renderHook(() =>
      useExplicitLocalChat('retained-profile', saved, null, false),
    );
    expect(result.current.intent.agentProfile).toEqual(agentProfile);
  },
);

it.each(['valid', 'wrong-workspace', 'wrong-conversation', 'private-path', 'oversized', 'missing'])(
  'retains only bounded repository presentation for the exact metadata workspace: %s',
  async (scenario) => {
    const data = localInventoryFixture();
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const repositoryContext = { workspaceId, repository: 'example/owned-repository' };
    if (scenario === 'wrong-workspace') repositoryContext.workspaceId = 'other-workspace';
    if (scenario === 'private-path') repositoryContext.repository = '/private/task';
    if (scenario === 'oversized') repositoryContext.repository = 'r'.repeat(201);
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      Response.json(
        String(url).includes('/meta')
          ? {
              sessionId: scenario === 'wrong-conversation' ? 'other-chat' : 'current-chat',
              repositoryWorkspaceId: workspaceId,
              ...(scenario === 'missing' ? {} : { repositoryContext }),
            }
          : data,
      ),
    );
    const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'current-chat', true));
    await waitFor(() => expect(result.current.metadataPending).toBe(false));
    expect(result.current.repositoryWorkspaceId).toBe(workspaceId);
    expect(result.current).toHaveProperty(
      'repositoryContext',
      scenario === 'valid' ? repositoryContext : undefined,
    );
    expect(result.current.metadataUnavailable).toBe(false);
  },
);

it('fences late repository presentation and clears it synchronously when the selected conversation changes', async () => {
  const data = localInventoryFixture();
  let finish!: (response: Response) => void;
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/meta')
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Response.json(data),
  );
  const { result, rerender } = renderHook(
    ({ sessionId }) => useExplicitLocalChat('draft', null, sessionId, true),
    { initialProps: { sessionId: 'old-chat' as string | null } },
  );
  await waitFor(() => expect(finish).toBeDefined());
  rerender({ sessionId: null });
  await act(async () =>
    finish(
      Response.json({
        sessionId: 'old-chat',
        repositoryWorkspaceId: workspaceId,
        repositoryContext: { workspaceId, repository: 'example/old-repository' },
      }),
    ),
  );
  expect(result.current).toHaveProperty('repositoryContext', undefined);
  expect(result.current.repositoryWorkspaceId).toBeUndefined();
});

it('withholds repository presentation while metadata refresh is pending or fails', async () => {
  const data = localInventoryFixture();
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  let failRefresh = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (!String(url).includes('/meta')) return Response.json(data);
    if (failRefresh) throw Error('Metadata read failed');
    return Response.json({
      sessionId: 'current-chat',
      repositoryWorkspaceId: workspaceId,
      repositoryContext: { workspaceId, repository: 'example/owned-repository' },
    });
  });
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'current-chat', true));
  await waitFor(() =>
    expect(result.current).toHaveProperty('repositoryContext', {
      workspaceId,
      repository: 'example/owned-repository',
    }),
  );
  failRefresh = true;
  act(() => result.current.refresh());
  expect(result.current).toHaveProperty('repositoryContext', undefined);
  await waitFor(() => expect(result.current.metadataUnavailable).toBe(true));
  expect(result.current).toHaveProperty('repositoryContext', undefined);
  expect(result.current.repositoryWorkspaceId).toBe(workspaceId);
});

it.each(['', 'agentProfile=agent&profileRevision=1'])(
  'resolves a fresh saved default to its current account identity without a second confirmation: %s',
  async (search) => {
    const account = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' };
    setDefaultAccountModel(account);
    vi.mocked(apiFetch).mockImplementation(
      async () => new Response(JSON.stringify(localInventoryFixture())),
    );
    const { result } = renderHook(() => useExplicitLocalChat('fresh', null, null, true, search));
    expect(result.current.intent.account).toEqual(account);
    expect(result.current.intent.accountReference ?? null).toBeNull();
    await waitFor(() => expect(result.current.inventory).not.toBeNull());
    expect(result.current.accountNeedsConfirmation).toBe(false);
    expect(result.current.intent.accountReference).toEqual(
      localInventoryFixture().accounts[0].account,
    );
    expect(result.current.reason ?? '').not.toContain('account identity is unconfirmed');
    expect(result.current.intent.execution.targetId).toBeNull();
  },
);

it.each([null, { accountId: 'saved', model: 'saved-model', reasoningEffort: 'low' }])(
  'keeps retained draft intent ahead of browser defaults, including an explicitly empty account: %j',
  async (account) => {
    setDefaultAccountModel({ accountId: 'personal', model: 'luna-fixture' });
    vi.mocked(apiFetch).mockImplementation(
      async () => new Response(JSON.stringify(localInventoryFixture())),
    );
    const saved = { ...createChatRuntimeSelection(), account };
    const { result } = renderHook(() => useExplicitLocalChat('saved', saved, null, true));
    await waitFor(() => expect(result.current.inventory).not.toBeNull());
    expect(result.current.intent.account).toEqual(account);
  },
);

it('ignores malformed browser defaults and never seeds existing conversations from preferences', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify(localInventoryFixture())),
  );
  setDefaultAccountModel({ accountId: 'bad account id', model: 'bad model id' });
  const fresh = renderHook(() => useExplicitLocalChat('fresh', null, null, true));
  expect(fresh.result.current.intent.account).toBeNull();
  fresh.unmount();
  setDefaultAccountModel({ accountId: 'personal', model: 'luna-fixture' });
  const existing = renderHook(() => useExplicitLocalChat('existing', null, 'session', true));
  expect(existing.result.current.intent.account).toBeNull();
  existing.unmount();
});

it.each([null, { accountId: 'legacy', model: 'retained-model', reasoningEffort: 'high' }])(
  'preserves older restored drafts without runtime metadata ahead of browser defaults: %j',
  async (savedAccount) => {
    setDefaultAccountModel({ accountId: 'personal', model: 'luna-fixture' });
    vi.mocked(apiFetch).mockImplementation(
      async () => new Response(JSON.stringify(localInventoryFixture())),
    );
    const { result } = renderHook(() =>
      useExplicitLocalChat('legacy-draft', null, null, true, '', savedAccount),
    );
    await waitFor(() => expect(result.current.inventory).not.toBeNull());
    expect(result.current.intent.account).toEqual(savedAccount);
    expect(result.current.intent.accountReference ?? null).toBeNull();
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'a browser preference alone does not enroll runtime setup, while a saved runtime choice stays blocked: retained %s, default identity %s',
  async (retainedRuntime, defaultIdentity) => {
    const account = { accountId: 'personal', model: 'luna-fixture' };
    setDefaultAccountModel(
      account,
      defaultIdentity ? localInventoryFixture().accounts[0].account : null,
    );
    vi.mocked(apiFetch).mockImplementation(
      async () => new Response(JSON.stringify({ code: 'entry_disabled' }), { status: 503 }),
    );
    const saved = retainedRuntime ? { ...createChatRuntimeSelection(), account } : null;
    const { result } = renderHook(() => useExplicitLocalChat('draft', saved, null, true));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => {
      expect(result.current.reason).not.toBe('Checking execution choices…');
      expect(result.current.visible).toBe(retainedRuntime);
    });
    expect(result.current.intent.account).toEqual(account);
  },
);

it('hydrates the original recipe snapshot on cold resume and changes only future thinking intent', async () => {
  const data = localInventoryFixture();
  const definition = {
    ...data.agentProfiles[0].definition,
    contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'original' },
  };
  const profile = {
    ...data.agentProfiles[0],
    definition,
    contentHash: sha256Hex(JSON.stringify(definition)),
  };
  const context = {
    type: 'boot_context' as const,
    source: 'contexgin' as const,
    sourceCount: 1,
    tokenCount: 5,
    tokenBudget: 1000,
    sources: [{ path: 'source.md', kind: 'reference' }],
    included: [],
    trimmed: [],
    fullMarkdown: 'Original pinned context',
  };
  const snapshot = {
    profileId: profile.profileId,
    revision: profile.revision,
    profileHash: profile.contentHash,
    source: 'contexgin' as const,
    recipeHash: sha256Hex(JSON.stringify(definition.contextRecipe)),
    compilerRevision: 'offline-compiler',
    payloadHash: sha256Hex(JSON.stringify(context)),
    context,
  };
  const catalog = { ...data, agentProfiles: [profile] };
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('/meta')
            ? {
                runtimeBinding: {
                  version: 2,
                  account: data.accounts[0].account,
                  harness: { implementation: 'codex' },
                  execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
                },
                runtimeCommandScope: 'conversation',
                repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
                mode: 'agent',
                agentProfile: profile,
                agentContext: snapshot,
                modelSelection: { model: 'luna-fixture', reasoningEffort: 'low' },
              }
            : catalog,
        ),
      ),
  );
  const { result } = renderHook(() =>
    useExplicitLocalChat('draft', null, 'original-session', true),
  );
  await waitFor(() => expect(result.current.continuation).toBe(true));
  expect(result.current.agentProfile).toEqual(profile);
  expect(result.current.agentContext).toEqual(snapshot);
  act(() =>
    result.current.update({
      ...result.current.intent,
      account: { ...result.current.intent.account!, reasoningEffort: 'high' },
    }),
  );
  const next = prepareLocalContinuationCommand(result.current.intent, result.current.inventory, {
    sessionId: 'original-session',
    clientMsgId: 'next',
    repositoryWorkspaceId: result.current.repositoryWorkspaceId!,
    mode: 'agent',
    text: 'Continue',
    retainedAgentProfile: result.current.agentProfile,
    retainedAgentContext: result.current.agentContext,
  }).request!;
  expect(next.selection.context).toEqual({ source: 'contexgin', revision: snapshot.recipeHash });
  expect(next.selection.thinking).toBe('high');
  expect(result.current.agentContext).toEqual(snapshot);
});
it('keeps OpenShell default blocked after receiving only Local configuration', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(localInventoryFixture())));
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.execution.location).toBe('openshell');
  expect(result.current.reason).toBe('OpenShell execution choices are not available yet.');
});
it('retains saved Local target, profile and stale choices on disabled or failed inventory', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ code: 'entry_disabled' }), { status: 503 }),
  );
  const saved = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'original-target' },
    agentProfile: { profileId: 'original-agent', revision: 4 },
    capabilityRevision: 'old',
  };
  const { result } = renderHook(() => useExplicitLocalChat('draft', saved, null, true));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  expect(result.current.intent).toEqual(saved);
  expect(result.current.visible).toBe(true);
  expect(result.current.reason).toBeDefined();
});
it('does not acknowledge capability drift on refresh until explicit review', async () => {
  const data = localInventoryFixture();
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify(data)));
  const saved = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    agentProfile: { profileId: 'agent', revision: 1 },
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    capabilityRevision: 'older',
  };
  const { result } = renderHook(() => useExplicitLocalChat('draft', saved, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.capabilityRevision).toBe('older');
  act(() => result.current.review());
  expect(result.current.intent.capabilityRevision).toBe(data.capabilityRevision);
});
it('preserves explicit published URL choice and invalidates review on deliberate URL revision edit', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify(localInventoryFixture())),
  );
  const { result, rerender } = renderHook(
    ({ search }) => useExplicitLocalChat('draft', null, null, true, search),
    { initialProps: { search: 'agentProfile=agent&profileRevision=1' } },
  );
  expect(result.current.intent.agentProfile).toEqual({ profileId: 'agent', revision: 1 });
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  act(() =>
    result.current.update({
      ...result.current.intent,
      execution: { location: 'local', targetId: 'mac' },
      capabilityRevision: 'caps-r1',
    }),
  );
  rerender({ search: 'agentProfile=agent&profileRevision=4' });
  expect(result.current.intent.agentProfile).toEqual({ profileId: 'agent', revision: 4 });
  expect(result.current.intent.capabilityRevision).toBeNull();
  expect(result.current.intent.execution.location).toBe('local');
});
it('retains explicit empty-composer Local intent across responsive remount and resets on genuine New', async () => {
  const { ChatRuntimeDraftProvider } = await import('../ChatRuntimeDraftProvider');
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify(localInventoryFixture())),
  );
  const state: {
    intent?: ReturnType<typeof createChatRuntimeSelection>;
    update?: (choice: ReturnType<typeof createChatRuntimeSelection>) => void;
  } = {};
  function Screen({ draftId }: { draftId: string }) {
    const runtime = useExplicitLocalChat(draftId, null, null, true);
    state.intent = runtime.intent;
    state.update = runtime.update;
    return null;
  }
  const { rerender } = render(
    <ChatRuntimeDraftProvider owner="new:0">
      <Screen key="mobile" draftId="mobile-empty" />
    </ChatRuntimeDraftProvider>,
  );
  act(() =>
    state.update!({
      ...createChatRuntimeSelection(),
      execution: { location: 'local', targetId: 'mac' },
    }),
  );
  rerender(
    <ChatRuntimeDraftProvider owner="new:0">
      <Screen key="desktop" draftId="desktop-empty" />
    </ChatRuntimeDraftProvider>,
  );
  expect(state.intent!.execution).toEqual({ location: 'local', targetId: 'mac' });
  rerender(
    <ChatRuntimeDraftProvider owner="new:1">
      <Screen key="desktop-new" draftId="new-empty" />
    </ChatRuntimeDraftProvider>,
  );
  expect(state.intent!.execution.location).toBe('openshell');
});
it('keeps unknown session metadata fail-closed with visible retry, then recovers actual bound identity', async () => {
  let failed = true;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/meta'))
      return failed
        ? new Response('{}', { status: 503 })
        : new Response(
            JSON.stringify({
              runtimeCommandScope: 'first-command-only',
              runtimeBinding: {
                version: 2,
                account: localInventoryFixture().accounts[0].account,
                harness: { implementation: 'codex' },
                execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
              },
            }),
          );
    return new Response(JSON.stringify(localInventoryFixture()));
  });
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'known-session', true));
  expect(result.current.metadataPending).toBe(true);
  await waitFor(() => expect(result.current.metadataUnavailable).toBe(true));
  expect(result.current.metadataPending).toBe(true);
  expect(result.current.visible).toBe(true);
  expect(result.current.bound).toBe(false);
  expect(result.current.reason).toBe('Conversation settings are unavailable. Retry to continue.');
  failed = false;
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.bound).toBe(true));
  expect(result.current.binding!.execution.location).toBe('local');
  expect(result.current.metadataPending).toBe(false);
});

it('preserves a builtin launch namespace when switching to Local despite a matching user profile', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify(localInventoryFixture())),
  );
  const { result } = renderHook(() =>
    useExplicitLocalChat(
      'draft',
      null,
      null,
      true,
      'agentProfile=agent&profileRevision=1&agentProfileKind=builtin',
    ),
  );
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  act(() =>
    result.current.update({
      ...result.current.intent,
      execution: { location: 'local', targetId: 'mac' },
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
      capabilityRevision: 'caps-r1',
    }),
  );
  expect(result.current.intent.agentProfile).toEqual({
    kind: 'builtin',
    profileId: 'agent',
    revision: 1,
  });
  expect(result.current.reason).toBeDefined();
  expect(result.current.intent.execution.location).toBe('local');
});

it('hydrates supported continuation and accepts future model settings without rebinding identity', async () => {
  vi.mocked(apiFetch).mockClear();
  const data = localInventoryFixture();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('/meta')
            ? {
                runtimeBinding: {
                  version: 2,
                  account: data.accounts[0].account,
                  harness: { implementation: 'codex' },
                  execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
                },
                runtimeCommandScope: 'conversation',
                repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
                mode: 'agent',
                agentProfile: data.agentProfiles[0],
                modelSelection: { model: 'luna-fixture', reasoningEffort: 'low' },
              }
            : data,
        ),
      ),
  );
  const { result } = renderHook(() =>
    useExplicitLocalChat('draft', null, 'original-session', true),
  );
  await waitFor(() => expect(result.current.continuation).toBe(true));
  expect(result.current.intent.account).toEqual({
    accountId: 'personal',
    model: 'luna-fixture',
    reasoningEffort: 'low',
  });
  expect(result.current.repositoryWorkspaceId).toBe('11111111-1111-4111-8111-111111111111');
  act(() =>
    result.current.update({
      ...result.current.intent,
      account: { ...result.current.intent.account!, reasoningEffort: 'high' },
    }),
  );
  expect(result.current.intent.account?.reasoningEffort).toBe('high');
  act(() =>
    result.current.update({
      ...result.current.intent,
      execution: { location: 'openshell', targetId: 'other' },
    }),
  );
  expect(result.current.intent.execution).toEqual({ location: 'local', targetId: 'mac' });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('keeps OpenShell as default and resolves its sole trusted target without extra setup', async () => {
  const { ordinaryRuntimeInventoryFixture } =
    await import('../../test-utils/ordinary-runtime-inventory-fixture');
  const inventory = ordinaryRuntimeInventoryFixture();
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(inventory)));
  const { result } = renderHook(() => useExplicitLocalChat('new', null, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.execution).toEqual({ location: 'openshell', targetId: 'sandbox' });
  act(() =>
    result.current.update(
      {
        ...result.current.intent,
        account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
        agentProfile: { profileId: 'agent', revision: 1 },
      },
      true,
    ),
  );
  expect(result.current.intent.execution).toEqual({ location: 'openshell', targetId: 'sandbox' });
  expect(result.current.reason).toBeUndefined();
});

it('retains a saved OpenShell route visibly blocked when runtime enrollment is disabled', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ code: 'entry_disabled' }), { status: 503 }),
  );
  const saved = {
    ...createChatRuntimeSelection(),
    execution: { location: 'openshell' as const, targetId: 'original-sandbox' },
    account: { accountId: 'personal', model: 'luna-fixture' },
    capabilityRevision: 'original-caps',
  };
  const { result } = renderHook(() => useExplicitLocalChat('retained-sandbox', saved, null, true));
  await waitFor(() => expect(result.current.inventory).toBeNull());
  expect(result.current.visible).toBe(true);
  expect(result.current.intent).toEqual(saved);
  expect(result.current.reason).toBeDefined();
});

it('retains a bound future selection but blocks after metadata refresh fails and requires review of capability drift', async () => {
  const data = localInventoryFixture();
  let failed = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (!String(url).includes('/meta')) return new Response(JSON.stringify(data));
    if (failed) return new Response('{}', { status: 503 });
    return new Response(
      JSON.stringify({
        runtimeBinding: {
          version: 2,
          account: data.accounts[0].account,
          harness: { implementation: 'codex' },
          execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
        },
        runtimeCommandScope: 'conversation',
        mode: 'agent',
        agentProfile: data.agentProfiles[0],
        modelSelection: { model: 'luna-fixture', reasoningEffort: 'low' },
      }),
    );
  });
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'bound-session', true));
  await waitFor(() => expect(result.current.reason).toBeUndefined());
  expect(result.current.intent.capabilityRevision).toBe('caps-r1');
  failed = true;
  data.capabilityRevision = 'caps-r2';
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.metadataUnavailable).toBe(true));
  expect(result.current.metadataPending).toBe(true);
  expect(result.current.reason).toBe('Conversation settings are unavailable. Retry to continue.');
  expect(result.current.intent.capabilityRevision).toBe('caps-r1');
  failed = false;
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.metadataPending).toBe(false));
  expect(result.current.intent.capabilityRevision).toBe('caps-r1');
  expect(result.current.reason).toBe(
    'Execution choices changed. Refresh and review before sending.',
  );
  act(() => result.current.review());
  expect(result.current.intent.capabilityRevision).toBe('caps-r2');
  expect(result.current.reason).toBeUndefined();
});

it('retains copied account routing identity when the same ID changes billing until explicit Account selection', async () => {
  const data = localInventoryFixture();
  const original = { ...data.accounts[0].account };
  const saved = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    accountReference: original,
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'openshell' as const, targetId: null },
  };
  const changed = {
    ...data,
    accounts: [
      {
        ...data.accounts[0],
        account: {
          accountId: 'personal',
          provider: 'openai' as const,
          profileRevision: 'api-routing-r2',
        },
      },
    ],
    targets: [{ ...data.targets[0], location: 'openshell' as const, targetId: 'sandbox' }],
    routes: [
      {
        ...data.routes[0],
        account: {
          accountId: 'personal',
          provider: 'openai' as const,
          profileRevision: 'api-routing-r2',
        },
        targetId: 'sandbox',
      },
    ],
    locations: [{ location: 'openshell' as const, status: 'configured' as const }],
  };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(changed)));
  const { result } = renderHook(() => useExplicitLocalChat('elsewhere', saved, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.execution.targetId).toBeNull();
  expect(result.current.accountNeedsConfirmation).toBe(true);
  expect(result.current.intent.accountReference).toEqual(original);
  expect(result.current.reason).toBe(
    'The selected account provider changed, which may change authentication or billing. Choose the account again before sending.',
  );
  act(() =>
    result.current.update({
      ...result.current.intent,
      account: { ...result.current.intent.account!, reasoningEffort: 'high' },
    }),
  );
  expect(result.current.intent.accountReference).toEqual(original);
  expect(result.current.reason).toBeDefined();
  act(() => result.current.review());
  expect(result.current.intent.accountReference).toEqual(original);
  expect(result.current.reason).toBeDefined();
  act(() =>
    result.current.update(
      { ...result.current.intent, account: { ...result.current.intent.account! } },
      true,
    ),
  );
  expect(result.current.intent.accountReference).toEqual(changed.accounts[0].account);
  expect(result.current.accountNeedsConfirmation).toBe(false);
  expect(result.current.reason).toBeUndefined();
});

it('leaves legacy Agent-only launches on their existing picker when runtime enrollment is off', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ code: 'entry_disabled' }), { status: 503 }),
  );
  const { result } = renderHook(() =>
    useExplicitLocalChat(
      'legacy',
      undefined,
      null,
      true,
      'agentProfile=mitzo-profile-builder&profileRevision=1&agentProfileKind=builtin',
    ),
  );
  await waitFor(() => expect(result.current.reason).toBeUndefined());
  expect(result.current.visible).toBe(false);
  expect(result.current.intent.agentProfile).toMatchObject({
    profileId: 'mitzo-profile-builder',
    revision: 1,
    kind: 'builtin',
  });
  expect(result.current.intent.execution.location).toBe('openshell');
});
it('keeps account and model intent when a supported native route is unavailable in another environment', async () => {
  const { multiRuntimeInventoryFixture } =
    await import('../../test-utils/multi-runtime-inventory-fixture');
  const data = multiRuntimeInventoryFixture();
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(data)));
  const saved = {
    ...createChatRuntimeSelection(),
    agentProfile: { profileId: 'agent', revision: 1 },
    account: { accountId: 'api', model: 'shell-model', reasoningEffort: null },
    accountReference: data.accounts[1].account,
  };
  const { result } = renderHook(() => useExplicitLocalChat('multi', saved, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.execution.targetId).toBe('shell');
  act(() =>
    result.current.update({
      ...result.current.intent,
      execution: { location: 'local', targetId: null },
    }),
  );
  expect(result.current.intent.execution.targetId).toBeNull();
  expect(result.current.intent.account).toEqual(saved.account);
  expect(result.current.intent.accountReference).toEqual(saved.accountReference);
  expect(result.current.reason).toMatch(/target|execution|route/i);
  act(() =>
    result.current.update(
      {
        ...result.current.intent,
        account: { accountId: 'vertex', model: 'claude-model', reasoningEffort: null },
      },
      true,
    ),
  );
  expect(result.current.intent.execution.targetId).toBe('claude');
  expect(result.current.intent.accountReference).toEqual(data.accounts[2].account);
});

it('does not adopt reused billing identity for a restored legacy draft without an account reference', async () => {
  const data: import('../../lib/explicit-local-chat').ExplicitLocalInventory =
    localInventoryFixture();
  const replacement = {
    ...data.accounts[0].account,
    provider: 'openai' as const,
    profileRevision: 'replacement-api',
  };
  data.accounts[0].account = replacement;
  data.routes[0].account = replacement;
  const saved = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'local' as const, targetId: null },
  };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(data)));
  const { result } = renderHook(() => useExplicitLocalChat('legacy-retained', saved, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.accountReference).toBeFalsy();
  expect(result.current.intent.account).toEqual(saved.account);
  expect(result.current.intent.execution.targetId).toBeNull();
  act(() => result.current.review());
  expect(result.current.intent.accountReference).toBeFalsy();
  expect(result.current.reason).toMatch(/account.*identity.*choose the account again/i);
  act(() =>
    result.current.update({
      ...result.current.intent,
      execution: { location: 'openshell', targetId: null },
    }),
  );
  expect(result.current.intent.accountReference).toBeFalsy();
  act(() =>
    result.current.update(
      { ...result.current.intent, execution: { location: 'local', targetId: null } },
      true,
    ),
  );
  expect(result.current.intent.accountReference).toEqual(replacement);
  expect(result.current.intent.account).toEqual(saved.account);
});
it('requires explicit Account replacement if an early choice lacked trusted identity when capabilities arrived', async () => {
  const data = localInventoryFixture();
  let deliver!: (response: Response) => void;
  vi.mocked(apiFetch).mockReturnValue(
    new Promise<Response>((resolve) => {
      deliver = resolve;
    }),
  );
  const { result } = renderHook(() => useExplicitLocalChat('early-choice', null, null, true));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  act(() =>
    result.current.update(
      {
        ...result.current.intent,
        account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
        execution: { location: 'local', targetId: null },
        agentProfile: { profileId: 'agent', revision: 1 },
      },
      true,
    ),
  );
  await act(async () => {
    deliver(new Response(JSON.stringify(data)));
  });
  expect(result.current.intent.accountReference).toBeFalsy();
  expect(result.current.intent.execution.targetId).toBeNull();
  act(() => result.current.review());
  expect(result.current.intent.accountReference).toBeFalsy();
  expect(result.current.reason).toMatch(/account.*identity.*choose the account again/i);
  act(() => result.current.update(result.current.intent, true));
  expect(result.current.intent.accountReference).toEqual(data.accounts[0].account);
  expect(result.current.intent.execution.targetId).toBe('mac');
});

it('retains the default account identity across fresh chats and rejects later provider or revision drift', async () => {
  const first = localInventoryFixture();
  setDefaultAccountModel({ accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' });
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(first));
  const initial = renderHook(() => useExplicitLocalChat('first-preference', null, null, true));
  await waitFor(() =>
    expect(initial.result.current.intent.accountReference).toEqual(first.accounts[0].account),
  );
  initial.unmount();
  const current = renderHook(() => useExplicitLocalChat('second-preference', null, null, true));
  expect(current.result.current.intent.accountReference).toEqual(first.accounts[0].account);
  await waitFor(() => expect(current.result.current.inventory).not.toBeNull());
  expect(current.result.current.accountNeedsConfirmation).toBe(false);
  current.unmount();
  const changed = {
    ...first,
    accounts: first.accounts.map((entry) => ({
      ...entry,
      account: { ...entry.account, profileRevision: 'changed-r2' },
    })),
  };
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(changed));
  const stale = renderHook(() => useExplicitLocalChat('changed-preference', null, null, true));
  await waitFor(() => expect(stale.result.current.inventory).not.toBeNull());
  expect(stale.result.current.intent.accountReference).toEqual(first.accounts[0].account);
  expect(stale.result.current.accountNeedsConfirmation).toBe(true);
  act(() =>
    stale.result.current.update({
      ...stale.result.current.intent,
      execution: { location: 'local', targetId: null },
    }),
  );
  expect(stale.result.current.reason).toContain('configuration changed');
});

it('resolves the same saved default after New chat changes the draft identity without remounting', async () => {
  const { multiRuntimeInventoryFixture } =
    await import('../../test-utils/multi-runtime-inventory-fixture');
  const inventory = multiRuntimeInventoryFixture();
  const account = inventory.accounts.find((entry) => entry.account.accountId === 'api')!;
  setDefaultAccountModel(
    { accountId: 'api', model: 'shell-model', reasoningEffort: 'high' },
    account.account,
  );
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(inventory));
  const { result, rerender } = renderHook(({ id }) => useExplicitLocalChat(id, null, null, true), {
    initialProps: { id: 'first-new-chat' },
  });
  await waitFor(() => expect(result.current.intent.execution.targetId).toBe('shell'));
  rerender({ id: 'second-new-chat' });
  await waitFor(() => expect(result.current.intent.execution.targetId).toBe('shell'));
  expect(result.current.accountNeedsConfirmation).toBe(false);
  expect(result.current.intent.accountReference).toEqual(account.account);
});

it('does not borrow the current default identity to confirm a legacy restored draft without runtime metadata', async () => {
  const inventory = localInventoryFixture();
  const selection = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' };
  setDefaultAccountModel(selection, inventory.accounts[0].account);
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(inventory));
  const { result } = renderHook(() =>
    useExplicitLocalChat('legacy-selection-only', undefined, null, true, '', selection),
  );
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.account).toEqual(selection);
  expect(result.current.intent.accountReference ?? null).toBeNull();
  expect(result.current.accountNeedsConfirmation).toBe(true);
});
