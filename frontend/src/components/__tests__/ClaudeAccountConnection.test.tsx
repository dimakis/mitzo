// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClaudeAccountConnection } from '../ClaudeAccountConnection';
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  changed: vi.fn(),
  save: vi.fn(() => true),
  flush: vi.fn(async () => undefined),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
vi.mock('../../lib/symposium-account-catalog', () => ({
  invalidateSymposiumAccountCatalog: mocks.changed,
}));
vi.mock('../../lib/chat-drafts', () => ({
  createChatDraft: () => ({
    id: 'new-draft',
    settings: {},
    text: '',
    images: [],
    contextBlocks: [],
  }),
  saveChatDraft: mocks.save,
}));
vi.mock('../../lib/large-chat-storage', () => ({ chatStorage: { flush: mocks.flush } }));
const id = '4e58c106-af5f-4626-a0e7-130865fb8533';
const accountId = `claude-${id}`;
const pending = {
  requestId: id,
  accountId,
  label: 'Personal Claude',
  state: 'pending',
  expiresAt: Date.now() + 60_000,
  errorCode: null,
  diagnosticId: null,
  url: 'https://claude.com/cai/oauth/authorize?state=state',
};
const snapshot = (attempts: unknown[] = [], accounts: unknown[] = []) => ({
  enabled: true,
  attempts,
  accounts,
});
const response = (value: unknown) => new Response(JSON.stringify(value));
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.changed.mockClear();
  mocks.save.mockClear();
  localStorage.clear();
});
afterEach(cleanup);
function show() {
  return render(
    <MemoryRouter>
      <ClaudeAccountConnection />
    </MemoryRouter>,
  );
}
it('starts explicitly, hands off to Anthropic, and sends the code only through the private POST', async () => {
  let started = false;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/start')) {
      started = true;
      return response(pending);
    }
    if (url.endsWith('/code')) return response({ ...pending, state: 'verifying', url: undefined });
    return response(snapshot(started ? [pending] : []));
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
  expect(
    (await screen.findByRole('link', { name: 'Open Claude sign-in' })).getAttribute('href'),
  ).toBe(pending.url);
  const field = screen.getByLabelText('Sign-in code') as HTMLInputElement;
  expect(field.type).toBe('password');
  fireEvent.change(field, { target: { value: 'private-code#state' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }));
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/code'))).toBe(true),
  );
  const [url, options] = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/code'))!;
  expect(url).not.toContain('private-code');
  expect(JSON.parse(options.body)).toEqual({ code: 'private-code#state' });
  expect(localStorage.length).toBe(0);
  expect(field.value).toBe('');
});
it('recovers an existing attempt after navigation without launching another login and clears private input on logout', async () => {
  mocks.fetch.mockResolvedValue(response(snapshot([pending])));
  show();
  const field = (await screen.findByLabelText('Sign-in code')) as HTMLInputElement;
  fireEvent.change(field, { target: { value: 'unsent-code' } });
  expect(mocks.fetch.mock.calls.every(([url]) => !url.endsWith('/start'))).toBe(true);
  fireEvent(window, new Event('mitzo:auth-lost'));
  expect(field.value).toBe('');
  expect(screen.queryByRole('link', { name: 'Open Claude sign-in' })).toBeNull();
});
it('keeps uncertain code delivery visible and checks status without resubmitting', async () => {
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/code')) throw Error('network response lost');
    return response(snapshot([pending]));
  });
  show();
  fireEvent.change(await screen.findByLabelText('Sign-in code'), {
    target: { value: 'private-code#state' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Sign-in code') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Check sign-in status' }));
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/code'))).toHaveLength(1),
  );
});
it('retains a visible host-recovery failure and disables another login', async () => {
  mocks.fetch.mockImplementation(async () =>
    response(
      snapshot([
        {
          ...pending,
          state: 'failed',
          url: undefined,
          errorCode: 'CLAUDE_LOGIN_JOURNAL_FAILED',
          diagnosticId: 'safe-reference',
        },
      ]),
    ),
  );
  show();
  await screen.findByText(/needs recovery on the Mac/);
  expect(
    (screen.getByRole('button', { name: 'Sign in with Claude' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText('Reference: safe-reference')).toBeTruthy();
});
it('refreshes the picker after completion and prepares an unsent Local Mac draft for the connected account', async () => {
  const account = {
    id: accountId,
    label: 'Personal Claude',
    email: 'person@example.test',
    planType: 'max',
    verifiedAt: Date.now(),
  };
  mocks.fetch.mockResolvedValue(
    response(snapshot([{ ...pending, state: 'connected', url: undefined }], [account])),
  );
  const reference = { accountId, provider: 'anthropic-claude', profileRevision: 'personal-route' };
  mocks.fetch.mockImplementation(async (url: string) =>
    response(
      url.includes('/runtime/capabilities')
        ? {
            version: 1,
            authority: 'configuration-only',
            defaultLocation: 'openshell',
            capabilityRevision: 'current',
            accounts: [
              {
                account: reference,
                label: 'Personal Claude',
                models: [{ id: 'sonnet', label: 'Claude Sonnet' }],
                modelDiscovery: { source: 'configured', stale: false },
              },
            ],
            targets: [
              {
                targetId: 'mac',
                targetRevision: 'mac-v1',
                label: 'Local Mac',
                location: 'local',
                harness: 'claude-sdk',
              },
            ],
            routes: [
              {
                account: reference,
                targetId: 'mac',
                harness: 'claude-sdk',
                modes: ['ask', 'agent', 'auto'],
              },
            ],
            locations: [{ location: 'local', status: 'configured' }],
            agentProfiles: [],
          }
        : snapshot([{ ...pending, state: 'connected', url: undefined }], [account]),
    ),
  );
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Start chat' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          selection: { accountId, model: 'sonnet', reasoningEffort: null },
          retainRuntimeIntent: true,
          runtimeSelection: expect.objectContaining({
            execution: { location: 'local', targetId: 'mac' },
            accountReference: reference,
            account: { accountId, model: 'sonnet', reasoningEffort: null },
          }),
        }),
      }),
    ),
  );
  expect(mocks.changed).toHaveBeenCalled();
  expect(mocks.fetch.mock.calls.some(([url]) => /commands|send/.test(url))).toBe(false);
});
