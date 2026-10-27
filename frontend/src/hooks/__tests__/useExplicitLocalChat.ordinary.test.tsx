// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useExplicitLocalChat } from '../useExplicitLocalChat';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { multiRuntimeInventoryFixture } from '../../test-utils/multi-runtime-inventory-fixture';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
const workspaceId = '11111111-1111-4111-8111-111111111111';

it('refreshes the adopted checkout within one chat and retains it through repeated A to B to A switches', async () => {
  const f = fixture();
  Object.assign(f.metadata, {
    runtimeCommandScope: 'conversation',
    ordinaryWorkspaceId: undefined,
    repositoryWorkspaceId: 'old-checkout',
  });
  const view = renderHook(
    ({ session, branch }) =>
      useExplicitLocalChat('draft', null, session, true, '', undefined, branch),
    { initialProps: { session: 'chat-a', branch: 'old-branch' } },
  );
  await waitFor(() => expect(view.result.current.repositoryWorkspaceId).toBe('old-checkout'));
  Object.assign(f.metadata, { repositoryWorkspaceId: 'adopted-checkout' });
  view.rerender({ session: 'chat-a', branch: 'adopted-branch' });
  await waitFor(() => expect(view.result.current.repositoryWorkspaceId).toBe('adopted-checkout'));
  for (let turn = 0; turn < 3; turn++) {
    view.rerender({ session: 'chat-b', branch: 'other-branch' });
    await waitFor(() => expect(view.result.current.metadataPending).toBe(false));
    view.rerender({ session: 'chat-a', branch: 'adopted-branch' });
    await waitFor(() => expect(view.result.current.repositoryWorkspaceId).toBe('adopted-checkout'));
    expect(view.result.current.commandAvailable).toBe(true);
  }
});
it('ignores delayed old-workspace metadata after adoption and switching away and back', async () => {
  const f = fixture();
  Object.assign(f.metadata, {
    runtimeCommandScope: 'conversation',
    ordinaryWorkspaceId: undefined,
    repositoryWorkspaceId: 'old-checkout',
  });
  const view = renderHook(
    ({ session, branch }) =>
      useExplicitLocalChat('draft', null, session, true, '', undefined, branch),
    { initialProps: { session: 'chat-a', branch: 'old' } },
  );
  await waitFor(() => expect(view.result.current.repositoryWorkspaceId).toBe('old-checkout'));
  let finishOld!: () => void;
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          const old = JSON.stringify(f.metadata);
          finishOld = () => resolve(new Response(old));
        }),
    )
    .mockImplementation(original);
  act(() => view.result.current.refresh());
  await waitFor(() => expect(finishOld).toBeDefined());
  Object.assign(f.metadata, { repositoryWorkspaceId: 'adopted-checkout' });
  view.rerender({ session: 'chat-a', branch: 'adopted' });
  expect(view.result.current.commandAvailable).toBe(false);
  await waitFor(() => expect(view.result.current.repositoryWorkspaceId).toBe('adopted-checkout'));
  view.rerender({ session: 'chat-b', branch: 'other' });
  await waitFor(() => expect(view.result.current.metadataPending).toBe(false));
  view.rerender({ session: 'chat-a', branch: 'adopted' });
  await waitFor(() => expect(view.result.current.repositoryWorkspaceId).toBe('adopted-checkout'));
  await act(async () => finishOld());
  expect(view.result.current.repositoryWorkspaceId).toBe('adopted-checkout');
  expect(view.result.current.commandAvailable).toBe(true);
});
function fixture() {
  const inventory = localInventoryFixture();
  const metadata = {
    runtimeBinding: {
      version: 2,
      account: inventory.accounts[0].account,
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
    },
    runtimeCommandScope: 'prepared-first-command',
    ordinaryWorkspaceId: workspaceId,
    modelSelection: { model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: inventory.agentProfiles[0],
    mode: 'agent',
  };
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(JSON.stringify(String(url).includes('/meta') ? metadata : inventory)),
  );
  return { metadata, inventory };
}
it('leaves saved legacy metadata without a runtime binding on its existing surface', async () => {
  const f = fixture();
  Object.assign(f.metadata, {
    runtimeBinding: undefined,
    runtimeCommandScope: 'conversation',
    ordinaryWorkspaceId: undefined,
  });
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'legacy-unbound', true));
  await waitFor(() => expect(result.current.metadataPending).toBe(false));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.metadataUnavailable).toBe(false);
  expect(result.current.bound).toBe(false);
  expect(result.current.visible).toBe(false);
  expect(result.current.continuation).toBe(false);
});
it('requests retained Responses choices for the exact saved session and keeps its original capability revision', async () => {
  const inventory = multiRuntimeInventoryFixture();
  const route = inventory.routes.find((entry) => entry.harness === 'responses')!;
  const target = inventory.targets.find((entry) => entry.harness === 'responses')!;
  const retained = { ...inventory, capabilityRevision: 'retained-revision', routes: [route] };
  const fresh = { ...inventory, capabilityRevision: 'fresh-revision', routes: [] };
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes('/meta')
            ? {
                runtimeBinding: {
                  version: 2,
                  account: route.account,
                  harness: { implementation: 'responses' },
                  execution: {
                    location: 'local',
                    targetId: target.targetId,
                    targetRevision: target.targetRevision,
                  },
                },
                runtimeCommandScope: 'conversation',
                repositoryWorkspaceId: workspaceId,
                modelSelection: { model: 'local-model', reasoningEffort: 'low' },
                agentProfile: inventory.agentProfiles[0],
                mode: 'agent',
              }
            : String(url).includes('sessionId=retained-session')
              ? retained
              : fresh,
        ),
      ),
  );
  const { result } = renderHook(() =>
    useExplicitLocalChat('draft', null, 'retained-session', true),
  );
  await waitFor(() =>
    expect(result.current.inventory?.capabilityRevision).toBe('retained-revision'),
  );
  await waitFor(() => expect(result.current.continuation).toBe(true));
  expect(result.current.intent.execution.targetId).toBe(target.targetId);
  expect(result.current.intent.capabilityRevision).toBe('retained-revision');
  expect(result.current.reason).toBeUndefined();
});
it('recognizes the server-qualified repository preparation as a first command while preserving its original repository identity', async () => {
  const f = fixture();
  Object.assign(f.metadata, { ordinaryWorkspaceId: undefined, repositoryWorkspaceId: workspaceId });
  const { result } = renderHook(() =>
    useExplicitLocalChat('draft', null, 'prepared-repository', true),
  );
  await waitFor(() => expect(result.current.metadataPending).toBe(false));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.preparedFirst).toBe(true);
  expect(result.current.commandAvailable).toBe(true);
  expect(result.current.continuation).toBe(false);
  expect(result.current.repositoryWorkspaceId).toBe(workspaceId);
  expect(result.current.ordinaryWorkspaceId).toBeUndefined();
  expect(result.current.reason).toBeUndefined();
});
it('uses the original ordinary prepared identity for its explicit first command, then refreshes into continuation', async () => {
  const f = fixture();
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'prepared-chat', true));
  await waitFor(() => expect(result.current.metadataPending).toBe(false));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.preparedFirst).toBe(true);
  expect(result.current.commandAvailable).toBe(true);
  expect(result.current.continuation).toBe(false);
  expect(result.current.ordinaryWorkspaceId).toBe(workspaceId);
  expect(result.current.repositoryWorkspaceId).toBeUndefined();
  expect(result.current.reason).toBeUndefined();
  const original = result.current.intent;
  act(() =>
    result.current.update({
      ...original,
      account: { ...original.account!, reasoningEffort: 'high' },
    }),
  );
  expect(result.current.intent.account?.reasoningEffort).toBe('low');
  f.metadata.runtimeCommandScope = 'conversation';
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.continuation).toBe(true));
  expect(result.current.preparedFirst).toBe(false);
  expect(result.current.commandAvailable).toBe(true);
  act(() =>
    result.current.update({
      ...result.current.intent,
      account: { ...original.account!, reasoningEffort: 'high' },
    }),
  );
  expect(result.current.intent.account?.reasoningEffort).toBe('high');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(
        ([url]) => String(url).includes('/meta') || String(url).includes('/capabilities'),
      ),
  ).toBe(true);
});
it.each([
  { ordinaryWorkspaceId: undefined },
  { ordinaryWorkspaceId: 'not-an-id' },
  { repositoryWorkspaceId: workspaceId },
  { runtimeBinding: null },
])(
  'blocks malformed or ambiguous prepared metadata without a legacy fallback: %j',
  async (delta) => {
    const f = fixture();
    Object.assign(f.metadata, delta);
    const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'prepared-chat', true));
    await waitFor(() => expect(result.current.metadataUnavailable).toBe(true));
    expect(result.current.commandAvailable).toBe(false);
    expect(result.current.preparedFirst).toBe(false);
    expect(result.current.ordinaryWorkspaceId).toBeUndefined();
    expect(result.current.reason).toContain('settings are unavailable');
  },
);
it('withholds a prior ordinary command surface immediately on navigation and ignores its delayed metadata', async () => {
  const f = fixture();
  let finish!: () => void;
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((url, ...args) =>
    String(url).includes('/old/meta')
      ? new Promise((resolve) => {
          finish = () => resolve(new Response(JSON.stringify(f.metadata)));
        })
      : String(url).includes('/new/meta')
        ? Promise.resolve(new Response('{}', { status: 503 }))
        : original(url, ...args),
  );
  const { result, rerender } = renderHook(
    ({ sessionId }) => useExplicitLocalChat('draft', null, sessionId, true),
    { initialProps: { sessionId: 'old' } },
  );
  await waitFor(() => expect(finish).toBeDefined());
  rerender({ sessionId: 'new' });
  await act(async () => finish());
  await waitFor(() => expect(result.current.metadataUnavailable).toBe(true));
  expect(result.current.commandAvailable).toBe(false);
  expect(result.current.ordinaryWorkspaceId).toBeUndefined();
  expect(result.current.binding).toBeUndefined();
});

it('retains ordinary OpenShell identity across metadata hydration and continuation', async () => {
  const f = fixture();
  Object.assign(f.inventory.targets[0], { location: 'openshell', label: 'OpenShell' });
  Object.assign(f.inventory.locations[0], { status: 'configured' });
  Object.assign(f.metadata.runtimeBinding.execution, { location: 'openshell' });
  f.metadata.runtimeCommandScope = 'conversation';
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'shell-chat', true));
  await waitFor(() => expect(result.current.metadataPending).toBe(false));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  expect(result.current.ordinaryWorkspaceId).toBe(workspaceId);
  expect(result.current.binding?.execution.location).toBe('openshell');
  expect(result.current.continuation).toBe(true);
  expect(result.current.reason).toBeUndefined();
});

it('negotiates default workspace support without adding an unsupported cross-origin header', async () => {
  fixture();
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, null, true));
  await waitFor(() => expect(result.current.inventory).not.toBeNull());
  const call = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).includes('/capabilities'))!;
  expect(call[0]).toBe('/api/chat/runtime/capabilities?workspaceDefaults=1');
  expect(new Headers(call[1]?.headers).has('X-Mitzo-Workspace-Defaults')).toBe(false);
});
