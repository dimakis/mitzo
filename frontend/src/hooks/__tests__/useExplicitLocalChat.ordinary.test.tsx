// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useExplicitLocalChat } from '../useExplicitLocalChat';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
const workspaceId = '11111111-1111-4111-8111-111111111111';
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
