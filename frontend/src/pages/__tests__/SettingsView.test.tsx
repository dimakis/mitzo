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
