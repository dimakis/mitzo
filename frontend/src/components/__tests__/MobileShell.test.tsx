// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { MobileShell } from '../MobileShell';

const media = vi.hoisted(() => ({ desktop: false }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => media.desktop }));
afterEach(() => {
  cleanup();
  media.desktop = false;
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MobileShell>
        <Link to="/chat/example">Open conversation</Link>
      </MobileShell>
    </MemoryRouter>,
  );
}

describe('MobileShell navigation', () => {
  it.each(['/chat', '/chat/example', '/', '/todos/example', '/tasks', '/more'])(
    'keeps the menu available on %s',
    (path) => {
      renderAt(path);
      expect(screen.getByRole('link', { name: 'More' })).toBeTruthy();
    },
  );
  it('keeps navigation when entering a conversation from Chats', () => {
    renderAt('/sessions');
    fireEvent.click(screen.getByRole('link', { name: 'Open conversation' }));
    expect(screen.getByRole('link', { name: 'More' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Chats' }).getAttribute('aria-current')).toBe('page');
  });
  it('hides navigation on login', () => {
    renderAt('/login');
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('leaves desktop navigation to the desktop shell', () => {
    media.desktop = true;
    renderAt('/chat/example');
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
