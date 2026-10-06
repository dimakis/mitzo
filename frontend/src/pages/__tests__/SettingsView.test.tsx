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
