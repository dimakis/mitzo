// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useExplicitLocalChat } from '../useExplicitLocalChat';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
it('keeps OpenShell default blocked after receiving only Local configuration', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(localInventoryFixture())));
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.intent.execution.location).toBe('openshell');
  expect(result.current.reason).toBe('OpenShell is unavailable.');
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
