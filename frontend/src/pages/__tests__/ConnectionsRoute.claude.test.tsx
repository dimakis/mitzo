// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsRoute } from '../ConnectionsRoute';
vi.mock('../../lib/api-fetch', () => ({
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
  apiFetch: vi.fn(
    async () => new Response(JSON.stringify({ enabled: true, accounts: [], attempts: [] })),
  ),
}));
afterEach(cleanup);
it('reaches the real private Claude form from the Connections destination', async () => {
  render(
    <MemoryRouter initialEntries={['/connections?manage=claude']}>
      <ConnectionsRoute />
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Connect Claude');
  expect(await screen.findByRole('button', { name: 'Sign in with Claude' })).toBeTruthy();
  expect(screen.queryByText('Adding OpenAI API accounts is unavailable.')).toBeNull();
});
