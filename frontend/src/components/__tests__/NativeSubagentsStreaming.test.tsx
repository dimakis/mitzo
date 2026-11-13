// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatArea } from '../ChatArea';
import type { FinishedMessage, StreamingMessage } from '../../types/chat';

vi.mock('../../hooks/useNativeSubagents', () => ({
  useNativeSubagents: () => ({
    agents: [],
    available: true,
    control: vi.fn(),
    reconnect: vi.fn(),
    inspect: vi.fn(),
  }),
}));
afterEach(cleanup);
it('keeps persistent access when native activity moves from a streaming Map to finished blocks', () => {
  const current: StreamingMessage = {
    messageId: 'parent',
    blockOrder: ['children'],
    blocks: new Map([
      [
        'children',
        {
          blockId: 'children',
          blockType: 'tool_use',
          content: '',
          toolName: 'Agent',
          rawInput: { type: 'agent', nativeSubagentCommandId: 'command' },
          done: true,
        },
      ],
    ]),
  };
  const view = (stream: StreamingMessage | null, messages: FinishedMessage[]) => (
    <MemoryRouter>
      <ChatArea
        sessionId="streaming-child"
        current={stream}
        messages={messages}
        running={!!stream}
        permission={null}
        onPermissionRespond={() => {}}
      />
    </MemoryRouter>
  );
  const { rerender } = render(view(current, []));
  const launcher = screen.getByRole('button', { name: 'Agents in this session' });
  rerender(
    view(null, [
      {
        messageId: 'parent',
        role: 'assistant',
        blocks: [
          {
            blockId: 'children',
            blockType: 'tool_use',
            content: '',
            toolName: 'Agent',
            rawInput: { type: 'agent', nativeSubagentCommandId: 'command' },
            toolResult: 'Observed',
          },
        ],
      },
    ]),
  );
  expect(screen.getByRole('button', { name: 'Agents in this session' })).toBe(launcher);
});
