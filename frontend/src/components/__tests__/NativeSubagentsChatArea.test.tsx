// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatArea } from '../ChatArea';
import type { FinishedMessage } from '../../types/chat';

const control = vi.fn();
vi.mock('../../hooks/useNativeSubagents', () => ({
  useNativeSubagents: () => ({
    available: true,
    control,
    reconnect: vi.fn(),
    agents: [
      {
        commandId: 'command',
        threadId: 'child',
        parentThreadId: 'parent',
        name: 'Reviewer',
        task: 'Review',
        model: 'fixture',
        state: 'working',
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

it('retains the child dialog, draft and original uncertain request when real parent activity collapses', async () => {
  const scrollRef = { current: null as HTMLDivElement | null };
  const message: FinishedMessage = {
    messageId: 'parent',
    role: 'assistant',
    blocks: [
      {
        blockId: 'work',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolResult: 'Read source',
      },
      {
        blockId: 'children',
        blockType: 'tool_use',
        content: '',
        toolName: 'Agent',
        rawInput: { type: 'agent', nativeSubagentCommandId: 'command' },
        toolResult: 'Admitted',
      },
    ],
  };
  const view = (replied: boolean) => (
    <MemoryRouter>
      <ChatArea
        scrollRef={scrollRef}
        sessionId="chat"
        current={null}
        running={!replied}
        permission={null}
        onPermissionRespond={vi.fn()}
        messages={[
          {
            ...message,
            blocks: [
              ...message.blocks,
              ...(replied
                ? [{ blockId: 'reply', blockType: 'text' as const, content: 'Parent finished' }]
                : []),
            ],
          },
        ]}
      />
    </MemoryRouter>
  );
  const { rerender } = render(view(false));
  scrollRef.current!.scrollTo = vi.fn();
  fireEvent.click(screen.getByRole('button', { name: /1 subagent/ }));
  fireEvent.click(screen.getByRole('button', { name: /Reviewer.*Working/ }));
  const dialog = screen.getByRole('dialog', { name: 'Reviewer' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Reviewer' }), {
    target: { value: 'Keep this direction' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Reviewer' }));
  await screen.findByRole('button', { name: 'Check delivery' });
  rerender(view(true));
  expect(screen.getByRole('dialog', { name: 'Reviewer' })).toBe(dialog);
  expect(screen.getByRole('textbox', { name: 'Message Reviewer' })).toHaveProperty(
    'value',
    'Keep this direction',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery' }));
  expect(control.mock.calls[1][0]).toEqual(control.mock.calls[0][0]);
});
