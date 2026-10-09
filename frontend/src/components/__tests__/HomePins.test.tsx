// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePins } from '../HomePins';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const data = vi.hoisted(() => ({
  preferences: {
    revision: 0,
    names: { briefing: 'Minion', terminal: 'Minion' },
    pins: [
      { kind: 'session', id: 'a', title: 'First' },
      { kind: 'telos', id: 'b', title: 'Second' },
    ],
  },
  update: vi.fn(async (_patch: unknown) => true),
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({
    preferences: data.preferences,
    loading: false,
    saving: false,
    error: null,
    update: data.update,
  }),
}));
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({ items: [], loading: false, error: null }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    query: '',
    setQuery: vi.fn(),
    active: false,
    results: [],
    searching: false,
    error: null,
    retry: vi.fn(),
  }),
}));
beforeEach(() => {
  data.update.mockClear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
function show() {
  render(
    <MemoryRouter>
      <HomePins sessions={[{ id: 'c', summary: 'Third', lastModified: 1 }]} />
    </MemoryRouter>,
  );
}
describe('Today pins', () => {
  it('preserves native modal centering against the global margin reset', () => {
    const styles = readFileSync(resolve(process.cwd(), 'frontend/src/styles/home.css'), 'utf8');
    expect(styles.match(/\.home-dialog\s*\{([^}]+)\}/)?.[1]).toMatch(/margin:\s*auto\s*;/);
  });
  it('cancels reordered drafts without changing workspace preferences', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Manage pins' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Second up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(data.update).not.toHaveBeenCalled();
  });
  it('saves reordering and removal as a revision-protected preferences update', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Manage pins' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Second up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove First' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save pins' }));
    await waitFor(() =>
      expect(data.update).toHaveBeenCalledWith(
        {
          pins: [{ kind: 'telos', id: 'b', title: 'Second' }],
        },
        0,
      ),
    );
  });
  it('lets Add pin choose a real existing session', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add pin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Third' }));
    await waitFor(() =>
      expect(data.update).toHaveBeenCalledWith(
        {
          pins: [...data.preferences.pins, { kind: 'session', id: 'c', title: 'Third' }],
        },
        0,
      ),
    );
  });
});
