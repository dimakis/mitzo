// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TabBar } from '../TabBar';
const media = vi.hoisted(() => ({ desktop: false }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => media.desktop }));
afterEach(() => {
  cleanup();
  media.desktop = false;
});
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TabBar />
      <Location />
    </MemoryRouter>,
  );
}
describe('TabBar', () => {
  it('renders five named destinations', () => {
    renderAt('/');
    expect(screen.getAllByRole('link')).toHaveLength(5);
    for (const name of ['Today', 'Chats', 'Proposals', 'Work', 'More'])
      expect(screen.getByRole('link', { name })).toBeTruthy();
  });
  it('highlights Today on the home route', () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
  });
  it('highlights More for its secondary destinations', () => {
    renderAt('/tasks');
    expect(screen.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBe('page');
  });
  it('does not turn backlog size into notification badges', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('.tab-bar-badge')).toBeNull();
  });
  it('navigates to conversation history', () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('link', { name: 'Chats' }));
    expect(screen.getByTestId('location').textContent).toBe('/sessions');
  });
  it('uses the fixed tab bar and hides on desktop', () => {
    media.desktop = true;
    renderAt('/');
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
