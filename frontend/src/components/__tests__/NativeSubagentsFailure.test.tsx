// @vitest-environment node-compatible-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NativeSubagentSnapshot } from '@mitzo/protocol';
import { NativeSubagents } from '../NativeSubagents';

const feed = vi.hoisted(() => ({
  agents: [] as NativeSubagentSnapshot[],
  available: true,
  error: undefined as string | undefined,
  reconnect: vi.fn(),
  inspect: vi.fn(),
  control: vi.fn(),
}));
vi.mock('../../hooks/useNativeSubagents', () => ({ useNativeSubagents: () => feed }));
beforeEach(() => {
  feed.error = undefined;
  feed.agents = [
    {
      threadId: 'child',
      parentThreadId: 'parent',
      commandId: 'command',
      name: 'Reviewer',
      task: '',
      model: '',
      state: 'unknown',
      available: false,
      revision: 2,
      blocks: [],
      inspectionFailure: {
        code: 'native_subagent_inspection_failed',
        stage: 'validate_identity',
        reference: 'ea2532f4-b8d8-4495-bd80-543accf8b71e',
      },
    },
  ];
  window.HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  window.HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const tree = () => (
  <MemoryRouter>
    <NativeSubagents sessionId="chat" commandId="command" />
  </MemoryRouter>
);
function open() {
  fireEvent.click(screen.getByRole('button', { name: /1 subagent/ }));
  fireEvent.click(screen.getByRole('button', { name: /Reviewer.*Inspection unavailable/ }));
  return within(screen.getByRole('dialog', { name: 'Reviewer' }));
}
it('explains unknown activity with a recovery action and keeps diagnostics in details', () => {
  render(tree());
  const dialog = open();
  expect(dialog.getByText('Activity unavailable')).toBeTruthy();
  expect(dialog.getByText('No output is available yet.')).toBeTruthy();
  expect(dialog.getByRole('button', { name: 'Retry inspection' })).toBeTruthy();
  const details = dialog.getByText('Technical details').closest('details');
  expect(details).toHaveProperty('open', false);
  expect(details?.textContent).toContain('identity verification');
  expect(details?.textContent).toContain(feed.agents[0].inspectionFailure!.reference);
  expect(dialog.getByRole('textbox', { name: 'Message Reviewer' })).toHaveProperty('rows', 1);
  expect(dialog.getByRole('button', { name: 'Send to Reviewer' })).toHaveProperty('disabled', true);
});
it('shows retry errors inside the open dialog and retains the known output', () => {
  feed.agents[0].blocks = [{ id: 'output', type: 'text', content: 'Saved review output' }];
  const view = render(tree());
  const dialog = open();
  feed.error =
    'Subagent inspection is unavailable. Reconnect the original chat runtime and try again.';
  view.rerender(tree());
  expect(dialog.getByRole('alert').textContent).toContain(feed.error);
  expect(dialog.getByText('Saved review output')).toBeTruthy();
  expect(dialog.queryByText('No output is available yet.')).toBeNull();
});
