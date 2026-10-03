// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DesktopNav } from '../DesktopNav';
import { TabBar } from '../TabBar';
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => false }));
vi.mock('../../hooks/useTabBadges', () => ({
  useTabBadges: () => ({ inboxCount: 100, todoCount: 70 }),
}));
vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ preference: 'dark', setTheme: vi.fn() }),
}));
afterEach(cleanup);
it('desktop keeps every collection reachable and marks Today as current', () => {
  render(
    <MemoryRouter>
      <DesktopNav />
    </MemoryRouter>,
  );
  for (const name of ['Today', 'Chats', 'Proposals', 'Work', 'Agents', 'Calendar', 'Files', 'More'])
    expect(screen.getByRole('link', { name })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
});
it('mobile uses five calm destinations without backlog badges', () => {
  render(
    <MemoryRouter initialEntries={['/todos/record']}>
      <TabBar />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('link')).toHaveLength(5);
  expect(screen.getByRole('link', { name: 'Work' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'Chats' }).getAttribute('href')).toBe('/sessions');
});
it('desktop highlights Chats inside an existing conversation', () => {
  render(
    <MemoryRouter initialEntries={['/chat/session-1']}>
      <DesktopNav />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Chats' }).getAttribute('aria-current')).toBe('page');
});

it('desktop opens Connections and retains its selection in management', () => {
  render(
    <MemoryRouter initialEntries={['/connections']}>
      <DesktopNav />
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: 'Connections' });
  expect(link.getAttribute('href')).toBe('/connections-access');
  expect(link.getAttribute('aria-current')).toBe('page');
});
it('mobile keeps More selected in the connections overview', () => {
  render(
    <MemoryRouter initialEntries={['/connections-access']}>
      <TabBar />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getAllByRole('link')).toHaveLength(5);
});

it('mobile keeps More selected while reviewing notifications', () => {
  render(
    <MemoryRouter initialEntries={['/notifications?item=p1']}>
      <TabBar />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBe('page');
});
