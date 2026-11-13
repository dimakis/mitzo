// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSubagentsSession } from '../NativeSubagentsSession';

vi.mock('../../hooks/useNativeSubagents', () => ({
  useNativeSubagents: () => ({
    available: true,
    reconnect: vi.fn(),
    inspect: vi.fn(),
    control: vi.fn(),
    agents: [
      {
        commandId: 'first',
        threadId: 'peirce',
        parentThreadId: 'root',
        name: 'Peirce',
        task: 'Review recovery',
        model: 'fixture',
        state: 'working',
        available: true,
        revision: 1,
        blocks: [],
      },
    ],
  }),
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['hide', 'escape', 'back'] as const)(
  'returns keyboard focus to the persistent launcher after %s',
  (action) => {
    render(
      <MemoryRouter>
        <NativeSubagentsSession sessionId="chat">Conversation</NativeSubagentsSession>
      </MemoryRouter>,
    );
    const launcher = screen.getByRole('button', { name: 'Agents in this session' });
    fireEvent.click(launcher);
    const row = screen.getByRole('button', { name: /Peirce.*Working/ });
    row.focus();
    fireEvent.click(row);
    const dialog = screen.getByRole('dialog', { name: 'Peirce' });
    const hide = within(dialog).getByRole('button', { name: 'Hide agent chat' });
    hide.focus();
    if (action === 'escape') fireEvent(dialog, new Event('cancel', { cancelable: true }));
    else
      fireEvent.click(
        action === 'back' ? within(dialog).getByRole('button', { name: 'Back to agents' }) : hide,
      );
    expect(document.activeElement).toBe(launcher);
    if (action === 'back') expect(launcher.getAttribute('aria-expanded')).toBe('true');
  },
);
