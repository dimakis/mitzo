// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { AccountModelPicker } from '../AccountModelPicker';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const profiles = [
  {
    id: 'work',
    label: 'Work Vertex',
    provider: 'anthropic-vertex',
    billing: 'google-cloud',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
  },
  {
    id: 'other',
    label: 'Other Vertex',
    provider: 'anthropic-vertex',
    billing: 'google-cloud',
    models: [{ id: 'haiku', label: 'Haiku' }],
  },
];
it('loads accounts and models from the server and emits explicit selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => profiles } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  await screen.findByText('Work Vertex');
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ accountId: 'work', model: 'sonnet' }),
  );
  fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'other' } });
  expect(onChange).toHaveBeenLastCalledWith({ accountId: 'other', model: 'haiku' });
});
it('shows the durable binding for an existing conversation without selectable accounts', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      accountBinding: { accountId: 'work', accountLabel: 'Work Vertex', model: 'sonnet' },
    }),
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="saved" preferredModel="wrong" onChange={onChange} />);
  await screen.findByText('Work Vertex · sonnet');
  expect(onChange).toHaveBeenLastCalledWith({ accountId: 'work', model: 'sonnet' });
  expect(screen.queryByLabelText('Account')).toBeNull();
});
it('immediately enables legacy conversations whose metadata has no account binding', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ sessionId: 'legacy' }),
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="legacy" preferredModel="sonnet" onChange={onChange} />);
  await screen.findByText('Existing task · legacy account');
  expect(onChange).toHaveBeenLastCalledWith({ model: 'sonnet' });
});
it('fails closed when the account catalog cannot load', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  await screen.findByRole('alert');
  expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
});
it('retries a failed account request without changing billing routes', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ ok: false } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => profiles } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  await screen.findByRole('alert');
  expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry accounts' }));
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith({ accountId: 'work', model: 'sonnet' }),
  );
});
it('offers an explicit legacy model choice when no accounts are configured', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
      ],
    } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Use legacy server account' }));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ model: 'sonnet' }));
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'haiku' } });
  expect(onChange).toHaveBeenLastCalledWith({ model: 'haiku' });
});
it('reports malformed catalogs and notifies the pending-prompt owner', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [{ id: 'work', label: 'Work', models: [] }],
  } as Response);
  const onUnavailable = vi.fn();
  render(
    <AccountModelPicker
      sessionId={null}
      preferredModel="sonnet"
      onChange={vi.fn()}
      onUnavailable={onUnavailable}
    />,
  );
  await screen.findByRole('alert');
  await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Retry accounts' })).toBeTruthy();
});

it('allows a bound Codex chat to select its next model without changing subscription', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      accountBinding: { accountId: 'personal', accountLabel: 'Personal', model: 'luna' },
      modelSelection: {
        model: 'luna',
        reasoningEffort: null,
        models: [
          { id: 'luna', label: 'Luna', reasoningEfforts: ['low', 'high'] },
          { id: 'terra', label: 'Terra' },
        ],
      },
    }),
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="saved" preferredModel="wrong" onChange={onChange} />);
  await screen.findByLabelText('Model');
  expect(screen.queryByLabelText('Account')).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'luna',
    reasoningEffort: null,
  });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'terra' } });
  expect(onChange).toHaveBeenLastCalledWith({ accountId: 'personal', model: 'terra' });
});
it('saves a subscription alias without changing the selected account or model', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        json: async () => (path === '/api/accounts' ? profiles : { label: 'My work subscription' }),
      }) as Response,
  );
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  await screen.findByLabelText('Account');
  fireEvent.click(screen.getByRole('button', { name: 'Edit account alias' }));
  fireEvent.change(screen.getByLabelText('Account alias'), {
    target: { value: 'My work subscription' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save alias' }));
  await screen.findByText('My work subscription');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/accounts/work/alias',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ alias: 'My work subscription' }),
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({ accountId: 'work', model: 'sonnet' });
});

it('offers an explicit legacy choice after a catalog failure without silently switching accounts', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Network unavailable'));
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="legacy-model" onChange={onChange} />);
  const fallback = await screen.findByRole('button', { name: 'Use legacy server account' });
  expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }));
  vi.mocked(apiFetch).mockResolvedValueOnce({
    ok: true,
    json: async () => [{ id: 'legacy-model', label: 'Legacy model' }],
  } as Response);
  fireEvent.click(fallback);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ model: 'legacy-model' }));
});

it('waits for accepted session metadata to become available', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        accountBinding: { accountId: 'work', accountLabel: 'Work API', model: 'nano' },
      }),
    } as Response);
  render(<AccountModelPicker sessionId="starting" preferredModel="nano" onChange={vi.fn()} />);
  await screen.findByText('Work API · nano');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('falls back quickly when a legacy session has no event-store metadata', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 404 } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="legacy" preferredModel="sonnet" onChange={onChange} />);
  await screen.findByText('Existing task · legacy account', {}, { timeout: 1500 });
  expect(onChange).toHaveBeenLastCalledWith({ model: 'sonnet' });
  expect(apiFetch).toHaveBeenCalledTimes(4);
});
it('offers model-specific thinking choices and resets them when changing model', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => [
      {
        id: 'personal',
        label: 'ChatGPT',
        models: [
          {
            id: 'gpt-a',
            label: 'GPT A',
            reasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
          },
          {
            id: 'gpt-b',
            label: 'GPT B',
            reasoningEfforts: ['medium'],
            defaultReasoningEffort: 'medium',
          },
        ],
      },
    ],
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="gpt-a" onChange={onChange} />);
  const thinking = await screen.findByLabelText('Thinking');
  fireEvent.change(thinking, { target: { value: 'low' } });
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'gpt-a',
    reasoningEffort: 'low',
  });
  fireEvent.change(thinking, { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'gpt-a',
    reasoningEffort: null,
  });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-b' } });
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'gpt-b',
    reasoningEffort: 'medium',
  });
});
it('preserves an explicit model-default thinking selection when hydrating a conversation', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      accountBinding: { accountId: 'personal', accountLabel: 'ChatGPT', model: 'gpt-a' },
      modelSelection: {
        model: 'gpt-a',
        reasoningEffort: null,
        models: [
          {
            id: 'gpt-a',
            label: 'GPT A',
            reasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
          },
        ],
      },
    }),
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="saved" preferredModel="gpt-a" onChange={onChange} />);
  expect(((await screen.findByLabelText('Thinking')) as HTMLSelectElement).value).toBe('');
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'gpt-a',
    reasoningEffort: null,
  });
});
it('refreshes on request while preserving the selected account and thinking level', async () => {
  const accounts = [
    profiles[0],
    {
      id: 'personal',
      label: 'Personal',
      models: [
        {
          id: 'gpt',
          label: 'GPT',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low',
        },
      ],
    },
  ];
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => accounts } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  fireEvent.change(await screen.findByLabelText('Account'), { target: { value: 'personal' } });
  fireEvent.change(screen.getByLabelText('Thinking'), { target: { value: 'high' } });
  fireEvent.click(screen.getByText('Refresh models'));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/accounts?refresh=1', expect.anything()),
  );
  await screen.findByLabelText('Thinking');
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'gpt',
    reasoningEffort: 'high',
  });
});

it('loads only the configured Symposium account catalog without legacy alias controls', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => profiles } as Response);
  const onChange = vi.fn();
  render(
    <AccountModelPicker
      scope="symposium"
      sessionId={null}
      preferredModel="sonnet"
      onChange={onChange}
    />,
  );
  await screen.findByText('Work Vertex');
  expect(apiFetch).toHaveBeenCalledWith('/api/symposium/accounts', expect.anything());
  expect(screen.queryByRole('button', { name: 'Edit account alias' })).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith({ accountId: 'work', model: 'sonnet' });
});

it('fails closed for unavailable Symposium catalog and retries only that catalog', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  const onChange = vi.fn();
  render(
    <AccountModelPicker
      scope="symposium"
      sessionId={null}
      preferredModel="sonnet"
      onChange={onChange}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Symposium account catalog unavailable',
  );
  expect(screen.queryByText('Use legacy server account')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry accounts' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiFetch).mock.calls.every(([url]) => url === '/api/symposium/accounts')).toBe(
    true,
  );
  expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
});

it('does not offer legacy accounts for an empty Symposium catalog', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const onChange = vi.fn();
  render(
    <AccountModelPicker
      scope="symposium"
      sessionId={null}
      preferredModel="sonnet"
      onChange={onChange}
    />,
  );
  await screen.findByText('No Symposium account profiles configured.');
  expect(screen.queryByText('Use legacy server account')).toBeNull();
  expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
});

it('shows per-seat account ownership for Symposium without returning an ordinary model selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      sessionType: 'symposium',
      accountBinding: { accountId: 'owned', model: 'gpt-5.6-luna' },
    }),
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="symposium" preferredModel="" onChange={onChange} />);
  await screen.findByText('Accounts and models are selected per seat in Director controls.');
  expect(onChange.mock.calls.every(([value]) => value === null)).toBe(true);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('offers personal subscription setup only in the Symposium account catalog including empty catalogs', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
  const { rerender } = render(
    <AccountModelPicker scope="chat" sessionId={null} preferredModel="luna" onChange={vi.fn()} />,
  );
  await screen.findByText('No account profiles configured.');
  expect(screen.queryByRole('button', { name: 'Connect personal subscription' })).toBeNull();
  rerender(
    <AccountModelPicker
      scope="symposium"
      sessionId={null}
      preferredModel="luna"
      onChange={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole('button', { name: 'Manage personal ChatGPT accounts' }),
  ).toBeTruthy();
});

it('propagates later disabled state to an already open personal account manager', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      ({
        ok: true,
        json: async () => (url.endsWith('/connections') ? { connections: [] } : []),
      }) as Response,
  );
  const props = {
    scope: 'symposium' as const,
    sessionId: null,
    preferredModel: 'luna',
    onChange: vi.fn(),
  };
  const { rerender } = render(<AccountModelPicker {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage personal ChatGPT accounts' }));
  await screen.findByLabelText('Account label');
  rerender(<AccountModelPicker {...props} disabled />);
  expect((screen.getByLabelText('Account label') as HTMLInputElement).disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Add personal account' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it.each(['model', 'account'])(
  'keeps a removed %s draft unavailable after a personal model refresh until explicit selection',
  async (removed) => {
    let refreshed = false;
    const onChange = vi.fn();
    vi.mocked(apiFetch).mockImplementation(
      async (url) =>
        ({
          ok: true,
          json: async () => {
            if (url.endsWith('/models/refresh')) {
              refreshed = true;
              return { status: 'complete', inference: false, modelCount: 1 };
            }
            if (url.endsWith('/connections'))
              return {
                connections: [
                  { id: 'personal', label: 'Personal', state: 'connected', revision: 1 },
                ],
              };
            if (url.includes('/login/status')) return { state: 'unknown' };
            return [
              {
                id: refreshed && removed === 'account' ? 'replacement' : 'personal',
                label: 'Personal',
                models: [
                  {
                    id: refreshed ? 'new-model' : 'old-model',
                    label: refreshed ? 'New model' : 'Old model',
                  },
                ],
              },
            ];
          },
        }) as Response,
    );
    render(
      <AccountModelPicker
        scope="symposium"
        requireExplicitSelection
        sessionId={null}
        preferredModel="old-model"
        onChange={onChange}
      />,
    );
    await screen.findByRole('option', { name: 'Old model' });
    onChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Manage personal ChatGPT accounts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh supported models' }));
    await screen.findByText(/Selected account or model is unavailable/);
    expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
    const confirmation = screen.getByRole('button', { name: /^Use / }) as HTMLButtonElement;
    expect(confirmation.disabled).toBe(true);
    fireEvent.click(confirmation);
    expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
    if (removed === 'account')
      fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
        target: { value: 'replacement' },
      });
    else
      fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
        target: { value: 'new-model' },
      });
    fireEvent.click(screen.getByRole('button', { name: /^Use / }));
    expect(onChange).toHaveBeenLastCalledWith({
      accountId: removed === 'account' ? 'replacement' : 'personal',
      model: 'new-model',
    });
  },
);

it.each(['model', 'account'])(
  'keeps a removed %s draft unavailable after disconnect until explicit selection',
  async (removed) => {
    let refreshed = false;
    const onChange = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url.endsWith('/disconnect')) refreshed = true;
      return {
        ok: true,
        json: async () => {
          if (url.endsWith('/disconnect')) {
            refreshed = true;
            return { status: 'complete', inference: false, modelCount: 1 };
          }
          if (url.endsWith('/connections'))
            return {
              connections: [{ id: 'personal', label: 'Personal', state: 'connected', revision: 1 }],
            };
          if (url.includes('/login/status')) return { state: 'unknown' };
          return [
            {
              id: refreshed && removed === 'account' ? 'replacement' : 'personal',
              label: 'Personal',
              models: [
                {
                  id: refreshed ? 'new-model' : 'old-model',
                  label: refreshed ? 'New model' : 'Old model',
                },
              ],
            },
          ];
        },
      } as Response;
    });
    render(
      <AccountModelPicker
        scope="symposium"
        requireExplicitSelection
        sessionId={null}
        preferredModel="old-model"
        onChange={onChange}
      />,
    );
    await screen.findByRole('option', { name: 'Old model' });
    onChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Manage personal ChatGPT accounts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await screen.findByText(/Selected account or model is unavailable/);
    expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
    const confirmation = screen.getByRole('button', { name: /^Use / }) as HTMLButtonElement;
    expect(confirmation.disabled).toBe(true);
    fireEvent.click(confirmation);
    expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
    if (removed === 'account')
      fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
        target: { value: 'replacement' },
      });
    else
      fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
        target: { value: 'new-model' },
      });
    fireEvent.click(screen.getByRole('button', { name: /^Use / }));
    expect(onChange).toHaveBeenLastCalledWith({
      accountId: removed === 'account' ? 'replacement' : 'personal',
      model: 'new-model',
    });
  },
);

it('retains recovered callback completion while catalog reloads and requires explicit use', async () => {
  let catalogs = 0;
  let finish!: (value: Response) => void;
  const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/symposium/accounts') {
      if (++catalogs === 1) return response([]);
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    if (url.endsWith('/connections'))
      return response({
        connections: [{ id: 'work', label: 'Personal', state: 'connected', revision: 1 }],
      });
    return response({ state: 'completed', attemptId: 'login', connectionId: 'work' });
  });
  const onChange = vi.fn();
  render(
    <AccountModelPicker scope="symposium" sessionId={null} preferredModel="" onChange={onChange} />,
  );
  await screen.findByText('No Symposium account profiles configured.');
  fireEvent.click(screen.getByRole('button', { name: 'Manage personal ChatGPT accounts' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect personal subscription' }));
  await waitFor(() => expect(catalogs).toBe(2));
  expect(screen.getByText(/Previous login completed/)).toBeTruthy();
  await act(async () => {
    finish(response(profiles));
  });
  expect(screen.getByText(/Previous login completed/)).toBeTruthy();
  expect(onChange.mock.calls.every(([value]) => value === null)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Use Work Vertex · Sonnet' }));
  expect(onChange).toHaveBeenLastCalledWith({ accountId: 'work', model: 'sonnet' });
});

it('reenables explicit confirmation when a missing model returns on a later refresh', async () => {
  let refreshes = 0;
  const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/models/refresh')) {
      refreshes++;
      return response({ status: 'complete', inference: false, modelCount: 1 });
    }
    if (url.endsWith('/connections'))
      return response({
        connections: [{ id: 'work', label: 'Personal', state: 'connected', revision: 1 }],
      });
    if (url.includes('/login/status')) return response({ state: 'idle' });
    return response([
      {
        ...profiles[0],
        models: [
          {
            id: refreshes === 1 ? 'missing' : 'sonnet',
            label: refreshes === 1 ? 'Replacement' : 'Sonnet',
          },
        ],
      },
    ]);
  });
  const changed = vi.fn();
  render(
    <AccountModelPicker
      scope="symposium"
      requireExplicitSelection
      sessionId={null}
      preferredModel="sonnet"
      onChange={changed}
    />,
  );
  await screen.findByRole('option', { name: 'Sonnet' });
  fireEvent.click(screen.getByRole('button', { name: 'Manage personal ChatGPT accounts' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh supported models' }));
  await screen.findByText(/Selected account or model is unavailable/);
  expect((screen.getByRole('button', { name: /^Use / }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh supported models' }));
  await screen.findByRole('option', { name: 'Sonnet' });
  expect((screen.getByRole('button', { name: /^Use / }) as HTMLButtonElement).disabled).toBe(false);
  expect(changed).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole('button', { name: /^Use / }));
  expect(changed).toHaveBeenLastCalledWith({ accountId: 'work', model: 'sonnet' });
});

it('invalidates another mounted picker after account removal without selecting a replacement or looping', async () => {
  let removed = false;
  let reads = 0;
  const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('/disconnect')) {
      removed = true;
      return response({ state: 'disconnected' });
    }
    if (url.endsWith('/connections'))
      return response({
        connections: [
          {
            id: 'work',
            label: 'Personal',
            state: removed ? 'disconnected' : 'connected',
            revision: removed ? 2 : 1,
          },
        ],
      });
    if (url.includes('/login/status')) return response({ state: 'idle' });
    reads++;
    return response(removed ? [profiles[1]] : profiles);
  });
  const secondChanged = vi.fn();
  render(
    <>
      <section data-testid="first">
        <AccountModelPicker
          scope="symposium"
          sessionId={null}
          preferredModel="sonnet"
          onChange={vi.fn()}
        />
      </section>
      <section data-testid="second">
        <AccountModelPicker
          scope="symposium"
          sessionId={null}
          preferredModel="sonnet"
          onChange={secondChanged}
        />
      </section>
    </>,
  );
  const first = within(screen.getByTestId('first'));
  const second = within(screen.getByTestId('second'));
  await second.findByRole('option', { name: 'Sonnet' });
  secondChanged.mockClear();
  fireEvent.click(first.getByRole('button', { name: 'Manage personal ChatGPT accounts' }));
  fireEvent.click(await first.findByRole('button', { name: 'Disconnect' }));
  await second.findByText(/Selected account or model is unavailable/);
  expect(secondChanged.mock.calls.every(([value]) => value === null)).toBe(true);
  expect((second.getByRole('button', { name: /^Use / }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    await Promise.resolve();
  });
  expect(reads).toBe(6);
});
