// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionActions } from '../../components/SessionActions';
import { ConversationUnreadDot } from '../../components/ConversationUnreadDot';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: vi.fn(() => () => {}) } }));
vi.mock('../../components/HomePinButton', () => ({ HomePinButton: () => null }));
const initial = { latestReplySeq: 30, readReplySeq: 0, markedUnread: false, revision: 0 };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.dispatchEvent(new Event('mitzo:auth-lost'));
});

it('replaces the presence dot with an accessible unread-reply marker, updated by the session menu', async () => {
  const session = { id: 'chat', summary: 'Chat', lastModified: 100, replyReadState: initial };
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ...initial, readReplySeq: 30, revision: 1 })),
  );
  render(
    <>
      <ConversationUnreadDot session={session} />
      <SessionActions
        session={session}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        menu
      />
    </>,
  );
  expect(screen.getByLabelText('Unread reply')).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as read' }));
  await waitFor(() => expect(screen.queryByLabelText('Unread reply')).toBeNull());
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual({
    readReplySeq: 30,
    expectedRevision: 0,
  });
});

it('keeps a failed unread mutation visible and keeps its menu open for retry', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
  const close = vi.fn();
  render(
    <SessionActions
      session={{
        id: 'read-chat',
        summary: 'Read',
        lastModified: 100,
        replyReadState: { ...initial, readReplySeq: 30 },
      }}
      onOpen={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onClose={close}
      menu
    />,
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save read status');
  expect(close).not.toHaveBeenCalled();
});
