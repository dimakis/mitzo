// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AccountModelPicker } from '../AccountModelPicker';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
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
  render(<AccountModelPicker sessionId="saved" preferredModel="wrong" onChange={vi.fn()} />);
  await screen.findByText('Work Vertex · sonnet');
  expect(screen.queryByLabelText('Account')).toBeNull();
});
it('fails closed when the account catalog cannot load', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
  const onChange = vi.fn();
  render(<AccountModelPicker sessionId={null} preferredModel="sonnet" onChange={onChange} />);
  await screen.findByRole('alert');
  expect(onChange.mock.calls.every(([selection]) => selection === null)).toBe(true);
});
