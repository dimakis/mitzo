// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { AddReviewerSheet } from '../AddReviewerSheet';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button onClick={() => onChange({ accountId: 'a', model: 'luna' })}>Choose account</button>
  ),
}));
vi.mock('../SymposiumProfilePicker', () => ({
  SymposiumProfilePicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <button onClick={() => onChange({ profileId: 'review', revision: 1 })}>Choose profile</button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('starts independent and keeps controls out of the composer until opened', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: false })),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('Context package')).toHaveValue('independent');
  expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeDisabled();
});
it('does not read history for independent review or enable addition without explicit profile and boundary', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: true })),
  );
  render(<AddReviewerSheet sessionId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('context-turns')),
  ).toBe(false);
  fireEvent.click(screen.getByText('Choose account'));
  expect(screen.getByRole('button', { name: 'Add reviewer and queue context' })).toBeDisabled();
});
