// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useExplicitLocalChat } from '../useExplicitLocalChat';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { prepareLocalContinuationCommand } from '../../lib/explicit-local-chat';
import { sha256Hex } from '../../lib/browser-crypto';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);

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
    result.current.update({
      ...result.current.intent,
      account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
      agentProfile: { profileId: 'agent', revision: 1 },
    }),
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
it('resolves an account native tuple per environment without changing billing or invalid model intent', async () => {
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
  expect(result.current.intent.execution.targetId).toBe('responses');
  expect(result.current.intent.account).toEqual(saved.account);
  expect(result.current.intent.accountReference).toEqual(saved.accountReference);
  expect(result.current.reason).toMatch(/model/i);
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
