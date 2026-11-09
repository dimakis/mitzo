// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopShell } from '../DesktopShell';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../DesktopNav', () => ({ DesktopNav: () => <nav>Navigation</nav> }));
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  return render(
    <MemoryRouter>
      <DesktopShell
        left={<p>Conversations</p>}
        center={<textarea aria-label="Draft" defaultValue="Keep my draft" />}
        right={<p>Resources</p>}
      />
    </MemoryRouter>,
  );
}
it('resizes every expanded column by keyboard and restores widths on remount', () => {
  const view = mount();
  for (const label of ['navigation', 'conversations', 'resources']) {
    const separator = screen.getByRole('separator', { name: `Resize ${label}` });
    const start = Number(separator.getAttribute('aria-valuenow'));
    fireEvent.keyDown(separator, { key: label === 'resources' ? 'ArrowLeft' : 'ArrowRight' });
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(start + 10);
  }
  expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe(
    'Keep my draft',
  );
  const saved = screen
    .getByRole('separator', { name: 'Resize conversations' })
    .getAttribute('aria-valuenow');
  view.unmount();
  mount();
  expect(
    screen.getByRole('separator', { name: 'Resize conversations' }).getAttribute('aria-valuenow'),
  ).toBe(saved);
});
it('removes collapsed dividers and restores the preferred width when expanded', () => {
  mount();
  const divider = screen.getByRole('separator', { name: 'Resize conversations' });
  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  const width = divider.getAttribute('aria-valuenow');
  fireEvent.click(screen.getByTitle('Hide sidebar'));
  expect(screen.queryByRole('separator', { name: 'Resize conversations' })).toBeNull();
  fireEvent.click(screen.getByTitle('Show sidebar'));
  expect(
    screen.getByRole('separator', { name: 'Resize conversations' }).getAttribute('aria-valuenow'),
  ).toBe(width);
});
it('keeps resizing available and explains unavailable preference storage', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  mount();
  const divider = screen.getByRole('separator', { name: 'Resize navigation' });
  const start = Number(divider.getAttribute('aria-valuenow'));
  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  expect(Number(divider.getAttribute('aria-valuenow'))).toBe(start + 10);
  expect(screen.getByRole('status').textContent).toContain('this tab');
  expect(warning).toHaveBeenCalledWith(
    'Layout preference unavailable',
    expect.objectContaining({ code: 'layout_preference_unavailable', stage: 'write' }),
  );
});
it('adapts to a smaller window without overwriting the saved wide layout', () => {
  mount();
  const divider = screen.getByRole('separator', { name: 'Resize conversations' });
  fireEvent.keyDown(divider, { key: 'End' });
  const preferred = divider.getAttribute('aria-valuenow');
  const saved = localStorage.getItem('mitzo-desktop-panel-widths');
  Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
  fireEvent(window, new Event('resize'));
  expect(Number(divider.getAttribute('aria-valuenow'))).toBeLessThan(Number(preferred));
  expect(localStorage.getItem('mitzo-desktop-panel-widths')).toBe(saved);
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  fireEvent(window, new Event('resize'));
  expect(divider.getAttribute('aria-valuenow')).toBe(preferred);
});
it('does not add handles for absent panels', () => {
  render(
    <MemoryRouter>
      <DesktopShell center={<p>Only the center</p>} />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('separator')).toHaveLength(1);
  expect(screen.getByRole('separator', { name: 'Resize navigation' })).toBeTruthy();
});
it('reports unreadable saved widths and continues with a usable layout', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.setItem('mitzo-desktop-panel-widths', '{broken');
  mount();
  expect(
    screen.getByRole('separator', { name: 'Resize navigation' }).getAttribute('aria-valuenow'),
  ).toBe('168');
  expect(screen.getByRole('status').textContent).toContain('this tab');
});
