// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SlashPicker } from '../SlashPicker';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
});
it('does not borrow the old command catalogue while a different runtime is loading or fails', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json([{ name: 'old-skill', description: 'Old scope', scope: 'bundled' }]),
  );
  const props = { query: '/', onSelect: vi.fn(), onClose: vi.fn() };
  const view = render(<SlashPicker {...props} runtime="legacy" />);
  await screen.findByRole('button', { name: /old-skill/ });
  let reject!: (error: Error) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  view.rerender(<SlashPicker {...props} runtime="ordinary" />);
  expect(screen.queryByRole('button', { name: /old-skill/ })).toBeNull();
  reject(Error('offline'));
  await waitFor(() => expect(screen.getByText(/could not load/i)).toBeDefined());
  expect(screen.queryByRole('button', { name: /old-skill/ })).toBeNull();
});
