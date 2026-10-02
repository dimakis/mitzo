// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as baseRender, screen } from '@testing-library/react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createMitzoStore, type WebSocketLike } from '@mitzo/client';
import type { ReactNode } from 'react';
let currentSocket: WebSocketLike;
let currentStore: ReturnType<typeof createMitzoStore>;
function render(node: ReactNode) {
  currentStore = createMitzoStore({
    transport: { fetch: vi.fn().mockResolvedValue(response([])) },
    wsConfig: {
      buildUrl: () => 'ws://localhost/ws',
      createWebSocket: () => {
        currentSocket = {
          readyState: 1,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: vi.fn(),
          close: vi.fn(),
        };
        return currentSocket;
      },
    },
  });
  currentSocket.onopen?.({});
  currentSocket.onmessage?.({
    data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'initiating-tab' }),
  });
  return baseRender(<MitzoStoreProvider value={currentStore}>{node}</MitzoStoreProvider>);
}
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPublication } from '../SymposiumPublication';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  currentStore?.getState().invalidateAuthentication();
  sessionStorage.clear();
  vi.resetAllMocks();
});
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it('keeps native review prerequisites explicit without fabricating a record', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ available: true, credentials: [] }));
  render(<SymposiumPublication sessionId="session" record={null} />);
  expect(await screen.findByText(/trusted review record and completed artifact seal/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
});
it('requires principal preview and a separate grant before requesting normal approval', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/recovery?')) return response({ operations: [] });
    if (path.endsWith('/select'))
      return response({
        connectionId: 'write',
        connectionRevision: 1,
        credentialGeneration: 'generation',
      });
    if (path.endsWith('/artifact'))
      return response({
        recordId: 'record',
        recordHash: 'a'.repeat(64),
        sealId: 'seal',
        sealHash: 'b'.repeat(64),
        commit: 'commit',
      });
    if (path.endsWith('/preview'))
      return response({ principal: { host: 'github.com', numericId: 42, login: 'selected-user' } });
    if (path.endsWith('/grant')) return response({ id: 'grant', bindingHash: 'c'.repeat(64) });
    if (path.endsWith('/publish'))
      return response({
        status: 'succeeded',
        externalResultId: 'https://github.com/owner/repo/pull/1',
      });
    return response({
      available: true,
      credentials: [{ id: 'write', label: 'Write account', revision: 1 }],
    });
  });
  render(
    <SymposiumPublication sessionId="session" record={{ id: 'record', hash: 'a'.repeat(64) }} />,
  );
  fireEvent.change(await screen.findByLabelText('Publication credential'), {
    target: { value: 'write' },
  });
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'owner/repo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview selected account' }));
  expect(await screen.findByText(/selected-user.*42/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Use this account and artifact' }));
  fireEvent.change(screen.getByLabelText('PR title'), { target: { value: 'Reviewed change' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }));
  expect(await screen.findByRole('link', { name: 'Open pull request' })).toBeTruthy();
  const call = vi.mocked(apiFetch).mock.calls.find(([url]) => String(url).endsWith('/publish'))!;
  expect(JSON.parse(String(call[1]?.body)).body).toContain('Review record: record');
  expect(new Headers(call[1]?.headers).get('X-Connection-ID')).toBe('initiating-tab');
});

it('never invokes a saved uncertain publication after remount', async () => {
  const saved = {
    grantId: 'grant',
    bindingHash: 'c'.repeat(64),
    turnId: 'same-turn',
    idempotencyKey: 'same-key',
    baseBranch: 'main',
    title: 'Reviewed',
    body: 'Reviewed body',
    draft: true,
  };
  sessionStorage.setItem('mitzo-publication:session:record', JSON.stringify(saved));
  vi.mocked(apiFetch).mockResolvedValue(
    response({ available: true, credentials: [], operations: [] }),
  );
  render(
    <SymposiumPublication sessionId="session" record={{ id: 'record', hash: 'a'.repeat(64) }} />,
  );
  const button = await screen.findByRole('button', {
    name: 'Publication outcome requires verification',
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/publish'))).toBe(
    false,
  );
  expect(JSON.parse(sessionStorage.getItem('mitzo-publication:session:record')!)).toEqual(saved);
});

async function prepareInitialPublication(result: unknown) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('/recovery?')) return response({ operations: [] });
    if (path.endsWith('/select'))
      return response({
        connectionId: 'write',
        connectionRevision: 1,
        credentialGeneration: 'generation',
      });
    if (path.endsWith('/artifact'))
      return response({
        recordId: 'record',
        recordHash: 'a'.repeat(64),
        sealId: 'seal',
        sealHash: 'b'.repeat(64),
      });
    if (path.endsWith('/preview'))
      return response({ principal: { host: 'github.com', numericId: 42, login: 'selected-user' } });
    if (path.endsWith('/grant')) return response({ id: 'grant', bindingHash: 'c'.repeat(64) });
    if (path.endsWith('/publish')) return response(result);
    return response({
      available: true,
      credentials: [{ id: 'write', label: 'Write account', revision: 1 }],
    });
  });
  render(
    <SymposiumPublication sessionId="session" record={{ id: 'record', hash: 'a'.repeat(64) }} />,
  );
  fireEvent.change(await screen.findByLabelText('Publication credential'), {
    target: { value: 'write' },
  });
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'owner/repo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview selected account' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use this account and artifact' }));
  fireEvent.change(screen.getByLabelText('PR title'), { target: { value: 'Reviewed' } });
  return screen.findByRole('button', { name: 'Create PR' });
}
it.each(['failed', 'cancelled', 'denied'])(
  'initial publication releases terminal %s identity and requires fresh selection',
  async (status) => {
    fireEvent.click(await prepareInitialPublication({ status }));
    await screen.findByText(status);
    expect(sessionStorage.getItem('mitzo-publication:session:record')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Publication outcome requires verification' }),
    ).toBeNull();
    expect(
      (screen.getByLabelText('Publication credential').closest('fieldset') as HTMLFieldSetElement)
        .disabled,
    ).toBe(false);
  },
);
it('does not dispatch initial Create PR after authentication invalidates the live transport', async () => {
  const button = await prepareInitialPublication({ status: 'succeeded' });
  currentStore.getState().invalidateAuthentication();
  fireEvent.click(button);
  await screen.findByText('Connect this tab to the session before publishing');
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/publish')),
  ).toEqual([]);
});
