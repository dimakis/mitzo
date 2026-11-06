// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentMessageCard } from '../AgentMessageCard';
import type { AgentMessageProjection } from '@mitzo/protocol';

afterEach(cleanup);
const projection: AgentMessageProjection = {
  direction: 'incoming',
  senderName: 'Merge coordinator',
  recipientName: 'Subagents',
  timestamp: 1793925200000,
  message: {
    messageId: 'c5d70b9d-8b6f-4640-bdf4-a958abb272f6',
    commandId: 'agent-message:test',
    senderConversationId: 'sender',
    recipientConversationId: 'recipient',
    text: 'Pause until the coordinator releases you.\nKeep the whole message visible.',
    replyTo: null,
    status: 'queued',
    reason: null,
    sequence: 1,
  },
};
it('renders complete attributable incoming and outgoing messages and distinguishes queued from delivered', () => {
  const { rerender } = render(<AgentMessageCard projection={projection} />);
  expect(screen.getByText('Agent message received')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Merge coordinator' }).getAttribute('href')).toContain(
    'sender',
  );
  expect(screen.getByText(/Keep the whole message visible/)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('Queued');
  expect(screen.getByRole('status').textContent).toContain('not delivered');
  rerender(
    <AgentMessageCard
      projection={{
        ...projection,
        direction: 'outgoing',
        message: { ...projection.message, status: 'delivered' },
      }}
    />,
  );
  expect(screen.getByText('Agent message sent')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Delivered to agent');
  expect(screen.getByText(projection.message.messageId)).toBeTruthy();
});
