// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsView } from '../SettingsView';
const setTheme = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'system', setTheme }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('offers backup management and retains the existing appearance preference', () => {
  render(
    <MemoryRouter>
      <SettingsView />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Backups/ }).getAttribute('href')).toBe(
    '/settings/backups',
  );
  const backups = screen.getByRole('link', { name: 'Backups' });
  expect(backups.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(backups.textContent).toBe('Backups');
  fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
  expect(setTheme).toHaveBeenCalledWith('dark');
});

it.each(['light', 'dark'])('resets the theme, accent and UI font from %s', (theme) => {
  localStorage.clear();
  render(
    <MemoryRouter>
      <SettingsView />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Font' }), {
    target: { value: 'georgia' },
  });
  expect(document.documentElement.dataset.accent).toBe('teal');
  expect(document.documentElement.dataset.font).toBe('georgia');
  fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: theme } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset appearance' }));
  expect(setTheme).toHaveBeenLastCalledWith('system');
  expect(document.documentElement.dataset.accent).toBe('lavender');
  expect(document.documentElement.dataset.font).toBe('system');
});

it.each([
  ['Blue', 'blue', 'Verdana', 'verdana'],
  ['Mint', 'mint', 'Trebuchet MS', 'trebuchet'],
  ['Coral', 'coral', 'Palatino', 'palatino'],
  ['Plum', 'plum', 'Courier New', 'courier'],
])('selects and restores expanded picker choice %s', (label, accent, fontLabel, font) => {
  localStorage.clear();
  const view = render(
    <MemoryRouter>
      <SettingsView />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('radio', { name: label }));
  const fontOption = screen.getByRole('option', { name: fontLabel });
  expect(fontOption.getAttribute('value')).toBe(font);
  fireEvent.change(screen.getByRole('combobox', { name: 'Font' }), { target: { value: font } });
  expect(document.documentElement.dataset.accent).toBe(accent);
  expect(document.documentElement.dataset.font).toBe(font);
  view.unmount();
  render(
    <MemoryRouter>
      <SettingsView />
    </MemoryRouter>,
  );
  expect((screen.getByRole('radio', { name: label }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('combobox', { name: 'Font' }) as HTMLSelectElement).value).toBe(font);
});
