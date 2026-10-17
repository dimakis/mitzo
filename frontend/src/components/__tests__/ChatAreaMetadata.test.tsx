// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatArea } from '../ChatArea';
import type { FinishedMessage } from '@mitzo/protocol';

vi.mock('../MessageBubble', () => ({
  UserBubble: ({ text }: { text: string }) => <p>{text}</p>,
  TextBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));
afterEach(cleanup);
it('keeps independent per-message metadata with the existing transcript bodies through replay', () => {
  const messages: FinishedMessage[] = ['user', 'assistant'].map((role, i) => ({
    messageId: `projection-${i}`,
    role: role as FinishedMessage['role'],
    startedSeq: i,
    blocks: [{ blockId: `body-${i}`, blockType: 'text', content: `Retained body ${i}` }],
  }));
  const props = {
    messages,
    current: null,
    running: false,
    permission: null,
    onPermissionRespond: vi.fn(),
    renderMessageAttribution: (id: string) => <strong>Author {id}</strong>,
    renderMessageOutcome: (id: string) => (
      <details>
        <summary>Receipt {id}</summary>Independent result
      </details>
    ),
  };
  const { rerender } = render(<ChatArea {...props} />);
  expect(screen.getByText('Author projection-0')).toBeTruthy();
  expect(screen.getByText('Author projection-1')).toBeTruthy();
  const receipt = screen.getByText('Receipt projection-1').closest('details')!;
  receipt.open = true;
  rerender(<ChatArea {...props} messages={messages.map((m) => ({ ...m }))} />);
  expect(screen.getByText('Receipt projection-1').closest('details')).toBe(receipt);
  expect(receipt.open).toBe(true);
  expect(screen.getByText('Retained body 0')).toBeTruthy();
  expect(screen.getByText('Retained body 1')).toBeTruthy();
});
