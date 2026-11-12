// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentMessageCard } from '../AgentMessageCard';
afterEach(cleanup);
it('uses a directional event and preserves the exact long message in a disclosure', () => {
  const text = 'Exact receipt. '.repeat(150);
  const { container } = render(
    <AgentMessageCard
      projection={{
        direction: 'incoming',
        senderName: 'Recovery',
        recipientName: 'Coordinator',
        timestamp: 1793925200000,
        message: {
          messageId: 'receipt',
          commandId: 'command',
          senderConversationId: 'recovery',
          recipientConversationId: 'coordinator',
          text,
          replyTo: null,
          status: 'uncertain',
          reason: null,
          sequence: 1,
        },
      }}
    />,
  );
  expect(screen.getByText('Received from')).toBeTruthy();
  expect(screen.getByRole('link', { name: /Recovery/ }).getAttribute('href')).toBe(
    '/chat/recovery',
  );
  expect(screen.getByText('Read full message').closest('details')?.textContent).toContain(text);
  expect(screen.getByRole('status').textContent).toBe('Delivery unconfirmed');
  expect(container.querySelector('.conversation-event')).toBeTruthy();
});
