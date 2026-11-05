// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NativeSubagents } from '../NativeSubagents';
import type { NativeSubagentSnapshot } from '@mitzo/protocol';

const control = vi.fn();
let available = true;
const agents: NativeSubagentSnapshot[] = [
  {
    commandId: 'command',
    threadId: 'edge',
    parentThreadId: 'parent',
    name: 'Edge cases',
    task: 'Check whitespace',
    model: 'fixture',
    state: 'working',
    turnId: 'edge-turn',
    revision: 1,
    blocks: [{ id: 'output', type: 'text', content: 'Checking empty queries.' }],
  },
  {
    commandId: 'command',
    threadId: 'tests',
    parentThreadId: 'parent',
    name: 'Test review',
    task: 'Review regression tests',
    model: 'fixture',
    state: 'completed',
    revision: 1,
    blocks: [],
  },
  {
    commandId: 'another-command',
    threadId: 'other',
    parentThreadId: 'parent',
    name: 'Other turn',
    task: '',
    model: 'fixture',
    state: 'working',
    revision: 1,
    blocks: [],
  },
];
vi.mock('../../hooks/useNativeSubagents', () => ({
  useNativeSubagents: () => ({ agents, available, error: undefined, reconnect: vi.fn(), control }),
}));
beforeEach(() => {
  available = true;
  control.mockReset().mockResolvedValue('accepted');
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
function mount() {
  return render(
    <MemoryRouter>
      <textarea aria-label="Message Mitzo" defaultValue="Keep my parent draft" />
      <button type="button">Terminal</button>
      <button type="button">Context usage</button>
      <NativeSubagents sessionId="chat" commandId="command" />
    </MemoryRouter>,
  );
}
function open(name = 'Edge cases') {
  fireEvent.click(screen.getByRole('button', { name: /2 subagents/ }));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  return screen.getByRole('dialog', { name });
}
it('uses one collapsed row scoped to its spawning turn and preserves the parent composer and tools', () => {
  mount();
  expect(screen.getByRole('button', { name: /2 subagents.*1 working/ })).toBeTruthy();
  expect(screen.queryByText('Edge cases')).toBeNull();
  const dialog = open();
  expect(within(dialog).getByText('Checking empty queries.')).toBeTruthy();
  expect(within(dialog).getByText(/Subagent of/)).toBeTruthy();
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Keep my parent draft');
  expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Context usage' })).toBeTruthy();
  expect(screen.queryByText('Other turn')).toBeNull();
});
it('sends only to the selected child and retains separate drafts across closing and sibling selection', async () => {
  mount();
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Message Edge cases' }), {
    target: { value: 'Check tabs too' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back to conversation' }));
  fireEvent.click(screen.getByRole('button', { name: /Test review/ }));
  expect(screen.getByRole('textbox', { name: 'Message Test review' })).toHaveProperty('value', '');
  fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }));
  fireEvent.click(screen.getByRole('button', { name: /Edge cases/ }));
  expect(screen.getByRole('textbox', { name: 'Message Edge cases' })).toHaveProperty(
    'value',
    'Check tabs too',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send to Edge cases' }));
  await waitFor(() => expect(control).toHaveBeenCalledOnce());
  expect(control.mock.calls[0][0]).toMatchObject({
    threadId: 'edge',
    action: 'message',
    text: 'Check tabs too',
    requestId: expect.any(String),
  });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Message Edge cases' })).toHaveProperty('value', ''),
  );
});
it('checks an uncertain delivery using the original identity without clearing the draft', async () => {
  control.mockResolvedValueOnce('uncertain').mockResolvedValueOnce('accepted');
  mount();
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Message Edge cases' }), {
    target: { value: 'Check tabs' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send to Edge cases' }));
  const check = await screen.findByRole('button', { name: 'Check delivery' });
  expect(screen.getByRole('textbox', { name: 'Message Edge cases' })).toHaveProperty(
    'value',
    'Check tabs',
  );
  fireEvent.click(check);
  await waitFor(() => expect(control).toHaveBeenCalledTimes(2));
  expect(control.mock.calls[1][0]).toEqual(control.mock.calls[0][0]);
});
it('targets Stop to the selected child and keeps it distinct from parent controls', async () => {
  mount();
  const dialog = open();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Stop Edge cases' }));
  await waitFor(() =>
    expect(control).toHaveBeenCalledWith({
      action: 'stop',
      threadId: 'edge',
      requestId: expect.any(String),
    }),
  );
});
it('shows retained output while disabling controls when the original runtime is unavailable', () => {
  available = false;
  mount();
  const dialog = open();
  expect(within(dialog).getByText('Checking empty queries.')).toBeTruthy();
  expect(within(dialog).getByRole('textbox', { name: 'Message Edge cases' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(within(dialog).getByRole('button', { name: 'Stop Edge cases' })).toHaveProperty(
    'disabled',
    true,
  );
});
