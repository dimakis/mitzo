// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NativeSubagents } from '../NativeSubagents';
import type { NativeSubagentSnapshot } from '@mitzo/protocol';

const fixture = vi.hoisted(() => ({ control: vi.fn() }));
const agent: NativeSubagentSnapshot = {
  commandId: 'command',
  threadId: 'child',
  parentThreadId: 'parent',
  name: 'HTTP child',
  task: 'Review the draft',
  model: 'fixture',
  state: 'working',
  revision: 1,
  blocks: [],
};
vi.mock('../../hooks/useNativeSubagents', () => ({
  useNativeSubagents: () => ({ agents: [agent], available: true, control: fixture.control }),
}));
beforeEach(() => {
  fixture.control.mockReset().mockResolvedValue('accepted');
  vi.stubGlobal('crypto', {});
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(['message', 'stop'] as const)(
  'delivers %s without crypto.randomUUID on HTTP/legacy hosts',
  async (action) => {
    render(
      <MemoryRouter>
        <NativeSubagents sessionId="chat" commandId="command" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /1 subagent/ }));
    fireEvent.click(screen.getByRole('button', { name: /HTTP child/ }));
    const dialog = within(screen.getByRole('dialog', { name: 'HTTP child' }));
    if (action === 'message') {
      fireEvent.change(dialog.getByRole('textbox', { name: 'Message HTTP child' }), {
        target: { value: 'Review this version' },
      });
      fireEvent.click(dialog.getByRole('button', { name: 'Send to HTTP child' }));
    } else fireEvent.click(dialog.getByRole('button', { name: 'Stop HTTP child' }));
    await waitFor(() => expect(fixture.control).toHaveBeenCalledTimes(1));
    expect(fixture.control.mock.calls[0][0]).toMatchObject({
      threadId: 'child',
      action,
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
  },
);
