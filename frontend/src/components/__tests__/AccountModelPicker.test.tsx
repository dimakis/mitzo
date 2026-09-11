// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
        models: [
          { id: 'luna', label: 'Luna' },
          { id: 'terra', label: 'Terra' },
        ],
      },
    }),
  } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId="saved" preferredModel="wrong" onChange={onChange} />);
  await screen.findByLabelText('Model');
  expect(screen.queryByLabelText('Account')).toBeNull();
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
  });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-b' } });
  expect(onChange).toHaveBeenLastCalledWith({
    accountId: 'personal',
    model: 'gpt-b',
    reasoningEffort: 'medium',
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
