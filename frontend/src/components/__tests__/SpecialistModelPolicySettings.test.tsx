// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SpecialistModelPolicySettings } from '../SpecialistModelPolicySettings';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), AUTH_LOST_EVENT: 'auth-lost' }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});
const view = {
  workspace: {
    revision: 2,
    policy: {
      models: [{ accountId: 'personal', model: 'test-model', admission: 'ask', allowance: 4 }],
    },
  },
  conversation: { revision: 0, policy: null },
  accounts: [
    {
      id: 'personal',
      label: 'Personal subscription',
      models: [{ id: 'test-model', label: 'Test model' }],
    },
  ],
};
it('edits inherited policy as a conversation override with explicit unlimited allowance', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (_url, options) =>
      new Response(
        JSON.stringify(
          options?.method === 'PUT'
            ? { revision: 1, policy: JSON.parse(String(options.body)).policy }
            : view,
        ),
      ),
  );
  render(<SpecialistModelPolicySettings sessionId="chat" />);
  fireEvent.click(screen.getByText('Model policy'));
  await screen.findByLabelText('Admission for test-model');
  fireEvent.change(screen.getByLabelText('Admission for test-model'), {
    target: { value: 'auto' },
  });
  fireEvent.change(screen.getByLabelText('Allowance for test-model'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save model policy' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/specialist-model-policy/chat',
      expect.objectContaining({ method: 'PUT' }),
    ),
  );
  const call = vi.mocked(apiFetch).mock.calls.find(([, options]) => options?.method === 'PUT')!;
  expect(JSON.parse(String(call[1]!.body))).toMatchObject({
    scope: 'conversation',
    expectedRevision: 0,
    policy: {
      models: [{ accountId: 'personal', model: 'test-model', admission: 'auto', allowance: null }],
    },
  });
});
it('retains the exact uncertain save for retry and shows load errors', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    if (options?.method === 'PUT') throw Error('connection lost');
    return new Response(JSON.stringify(view));
  });
  render(<SpecialistModelPolicySettings sessionId="chat" />);
  fireEvent.click(screen.getByText('Model policy'));
  await screen.findByLabelText('Admission for test-model');
  fireEvent.click(screen.getByRole('button', { name: 'Save model policy' }));
  await screen.findByRole('button', { name: 'Retry original save' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry original save' }));
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'PUT'),
    ).toHaveLength(2),
  );
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'PUT');
  expect(writes[0][1]!.body).toBe(writes[1][1]!.body);
});
