// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { webcrypto } from 'node:crypto';
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function show(selectedAccountId?: string) {
  return render(
    <MemoryRouter>
      <ClaudeAccountConnection accountId={selectedAccountId} />
    </MemoryRouter>,
  );
}
const savedAccount = {
  id: accountId,
  label: 'Personal Claude',
  email: 'person@example.test',
  planType: 'max',
  verifiedAt: Date.now(),
};
it('keeps fresh setup separate from an old account and failed reconnect', async () => {
  mocks.fetch.mockImplementation(async () =>
    response(snapshot([{ ...pending, state: 'failed', url: undefined }], [savedAccount])),
  );
  show();
  await screen.findByRole('button', { name: 'Sign in with Claude' });
  expect(screen.queryByText('person@example.test · Max')).toBeNull();
  expect(screen.queryByText(/Claude sign-in failed/)).toBeNull();
});
it('offers confirmed removal after a failed reconnect and leaves fresh setup available', async () => {
  mocks.fetch.mockImplementation(async (url: string) =>
    response(
      url.endsWith('/remove')
        ? snapshot()
        : snapshot([{ ...pending, state: 'failed', url: undefined }], [savedAccount]),
    ),
  );
  show(accountId);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove account' }));
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remove'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await screen.findByRole('button', { name: 'Sign in with Claude' });
  expect(screen.queryByText('person@example.test · Max')).toBeNull();
  expect(mocks.changed).toHaveBeenCalled();
});
it('recovers a lost removal acknowledgement by reading status, without removing again', async () => {
  let removed = false;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/remove')) {
      removed = true;
      throw Error('response lost');
    }
    return response(snapshot([], removed ? [] : [savedAccount]));
  });
  show(accountId);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
  await screen.findByText(/Account removal could not be confirmed/);
  fireEvent.click(screen.getByRole('button', { name: 'Check sign-in status' }));
  await screen.findByRole('button', { name: 'Sign in with Claude' });
  expect(screen.queryByRole('button', { name: 'Confirm removal' })).toBeNull();
  expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/remove'))).toHaveLength(1);
});
it('bounds a hung sign-in request and recovers the original request without duplicating it', async () => {
  mocks.fetch.mockImplementation(async () => response(snapshot()));
  show();
  await screen.findByRole('button', { name: 'Sign in with Claude' });
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.getByRole('alert').textContent).toContain('Check status');
    expect(
      (screen.getByRole('button', { name: 'Check sign-in status' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
  mocks.fetch.mockImplementation(async () => response(snapshot()));
  fireEvent.click(screen.getByRole('button', { name: 'Check sign-in status' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Sign in with Claude' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  mocks.fetch.mockImplementation(async () => response(pending));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
  await screen.findByLabelText('Sign-in code');
  const starts = mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/start'));
  expect(starts).toHaveLength(2);
  expect(starts[1][1].body).toBe(starts[0][1].body);
});
it.each(['secure', 'http'] as const)(
  'starts explicitly on %s hosts and sends the code only through the private POST',
  async (host) => {
    if (host === 'http')
      vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    let started = false;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/start')) {
        started = true;
        return response(pending);
      }
      if (url.endsWith('/code'))
        return response({ ...pending, state: 'verifying', url: undefined });
      return response(snapshot(started ? [pending] : []));
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    expect(
      (await screen.findByRole('link', { name: 'Open Claude sign-in' })).getAttribute('href'),
    ).toBe(pending.url);
    const startBody = JSON.parse(
      mocks.fetch.mock.calls.find(([url]) => url.endsWith('/start'))![1].body,
    );
    expect(startBody.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
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
  },
);
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
it.each(['verified', 'failed', 'unavailable', 'revoked'] as const)(
  'checks connected native sign-in explicitly with visible progress and a bounded result: %s',
  async (outcome) => {
    const account = {
      id: accountId,
      label: 'Personal Claude',
      email: 'person@example.test',
      planType: 'max',
      verifiedAt: Date.now(),
    };
    let finish!: (value: Response) => void;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === '/api/connections-access')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return response(snapshot([], [account]));
    });
    show(accountId);
    await screen.findByText('person@example.test · Max');
    expect(mocks.fetch.mock.calls.some(([url]) => url === '/api/connections-access')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Check sign-in status' }));
    await screen.findByText('Checking native Claude sign-in…');
    expect(
      (screen.getByRole('button', { name: 'Checking sign-in…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await waitFor(() => expect(finish).toBeDefined());
    if (outcome === 'revoked') fireEvent(window, new Event('mitzo:auth-lost'));
    finish(
      response({
        generatedAt: Date.now(),
        sources: [
          {
            id: 'accounts',
            state: outcome === 'unavailable' ? 'unavailable' : 'available',
            reason: null,
          },
        ],
        resources:
          outcome === 'unavailable'
            ? []
            : [
                {
                  kind: 'ai-account',
                  owner: 'account-profiles',
                  nativeId: accountId,
                  provider: 'anthropic-claude',
                  signIn: {
                    status: outcome === 'failed' ? 'failed' : 'verified',
                    explanation: 'Safe native check reference.',
                  },
                },
              ],
      }),
    );
    if (outcome === 'revoked') {
      await screen.findByText('Sign in to Mitzo again to continue.');
      expect(screen.queryByText('Personal Claude: Signed in.')).toBeNull();
    } else if (outcome === 'verified') {
      await screen.findByText('Personal Claude: Signed in.');
    } else if (outcome === 'failed') {
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Safe native check reference.',
      );
    } else {
      expect((await screen.findByRole('alert')).textContent).toContain('could not be checked');
    }
    await waitFor(() => expect(screen.queryByText('Checking native Claude sign-in…')).toBeNull());
    expect(
      mocks.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
    ).toBe(true);
    expect(
      mocks.fetch.mock.calls.filter(([url]) => url === '/api/connections-access'),
    ).toHaveLength(1);
  },
);
it('ends a hung status read with a visible retry instead of leaving the button busy', async () => {
  mocks.fetch.mockImplementation(async () => response(snapshot()));
  show();
  await screen.findByRole('button', { name: 'Sign in with Claude' });
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Check sign-in status' }));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole('alert').textContent).toContain('could not be checked');
    expect(
      (screen.getByRole('button', { name: 'Check sign-in status' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
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
it('adds another independently named account without reusing the previous account label', async () => {
  const existing = {
    id: accountId,
    label: 'First Claude',
    email: 'first@example.test',
    planType: 'pro',
    verifiedAt: Date.now(),
  };
  mocks.fetch.mockImplementation(async (url: string) =>
    response(
      url.endsWith('/start')
        ? pending
        : snapshot(
            [{ ...pending, state: 'connected', url: undefined, label: 'First Claude' }],
            [existing],
          ),
    ),
  );
  show();
  fireEvent.change(await screen.findByLabelText('Account name'), {
    target: { value: 'Another Claude' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(true),
  );
  const body = JSON.parse(mocks.fetch.mock.calls.find(([url]) => url.endsWith('/start'))![1].body);
  expect(body.label).toBe('Another Claude');
  expect(body.accountId).toBeUndefined();
});
it.each([false, true])(
  'prepares a connected Local Mac draft only while authorization remains current (revoked: %s)',
  async (revoked) => {
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
    const reference = {
      accountId,
      provider: 'anthropic-claude',
      profileRevision: 'personal-route',
    };
    mocks.fetch.mockImplementation(async (url: string) => {
      if (revoked && url.includes('/runtime/capabilities'))
        fireEvent(window, new Event('mitzo:auth-lost'));
      return response(
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
      );
    });
    show(accountId);
    fireEvent.click(await screen.findByRole('button', { name: 'Start chat' }));
    if (revoked) {
      await screen.findByText('Sign in to Mitzo again to continue.');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Start chat' })).toBeNull());
      expect(mocks.save).not.toHaveBeenCalled();
      return;
    }
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
  },
);
