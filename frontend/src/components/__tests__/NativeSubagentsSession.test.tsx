// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSubagentsSession } from '../NativeSubagentsSession';
import { NativeSubagents } from '../NativeSubagents';

const control = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useNativeSubagents', () => ({
  useNativeSubagents: () => ({
    available: true,
    reconnect: vi.fn(),
    inspect: vi.fn(),
    control,
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
      {
        commandId: 'second',
        threadId: 'noether',
        parentThreadId: 'root',
        name: 'Noether',
        task: 'Review permissions',
        model: 'fixture',
        state: 'completed',
        available: true,
        revision: 1,
        blocks: [],
      },
    ],
  }),
}));
beforeEach(() => {
  control.mockReset().mockResolvedValue('uncertain');
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
function view() {
  return (
    <MemoryRouter>
      <NativeSubagentsSession sessionId="chat">
        <textarea aria-label="Parent draft" defaultValue="Keep parent text" />
        <NativeSubagents sessionId="chat" commandId="first" />
      </NativeSubagentsSession>
    </MemoryRouter>
  );
}
it('keeps one session-wide dialog and drafts across transcript entry, siblings, hiding and resizing', async () => {
  render(view());
  fireEvent.click(screen.getByRole('button', { name: /1 subagent/ }));
  fireEvent.click(screen.getByRole('button', { name: /Peirce.*Working/ }));
  expect(screen.getAllByRole('dialog', { name: 'Peirce' })).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Peirce' }), {
    target: { value: 'yo peirce' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
  expect(screen.getByRole('dialog', { name: 'Peirce' }).getAttribute('data-snap')).toBe('full');
  fireEvent.click(screen.getByRole('button', { name: 'Half screen' }));
  expect(screen.getByRole('dialog', { name: 'Peirce' }).getAttribute('data-snap')).toBe('half');
  fireEvent.click(screen.getByRole('button', { name: 'Hide agent chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agents in this session' }));
  fireEvent.click(screen.getByRole('button', { name: /Noether.*Result returned/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Noether' }), {
    target: { value: 'Keep sibling text' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Back to agents' }));
  fireEvent.click(screen.getByRole('button', { name: /Peirce.*Working/ }));
  const dialog = within(screen.getByRole('dialog', { name: 'Peirce' }));
  expect(dialog.getByRole('textbox', { name: 'Message Peirce' })).toHaveProperty(
    'value',
    'yo peirce',
  );
  fireEvent.click(dialog.getByRole('button', { name: 'Send to Peirce' }));
  await dialog.findByRole('button', { name: 'Check delivery' });
  fireEvent.click(screen.getByRole('button', { name: 'Hide agent chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Agents in this session' }));
  fireEvent.click(screen.getByRole('button', { name: /Peirce.*Working/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery' }));
  expect(control.mock.calls[1][0]).toEqual(control.mock.calls[0][0]);
  expect(screen.getByRole('textbox', { name: 'Parent draft' })).toHaveProperty(
    'value',
    'Keep parent text',
  );
});
