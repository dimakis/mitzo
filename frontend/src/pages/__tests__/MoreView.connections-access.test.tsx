// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MoreView } from '../MoreView';
vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ preference: 'system', setTheme: vi.fn() }),
}));
vi.mock('../../components/ServiceStatus', () => ({ ServiceStatus: () => null }));
vi.mock('../../lib/biometric', () => ({ deleteCredentials: vi.fn() }));
vi.mock('../../lib/watch-auth', () => ({ clearWatchToken: vi.fn() }));
afterEach(cleanup);
it('opens the unified overview from More', () => {
  render(
    <MemoryRouter>
      <MoreView />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Connections & access' }).getAttribute('href')).toBe(
    '/connections-access',
  );
});
