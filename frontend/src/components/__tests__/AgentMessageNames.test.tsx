// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { AgentMessageCard } from '../AgentMessageCard';
import { apiFetch } from '../../lib/api-fetch';
import type { AgentMessageProjection } from '@mitzo/protocol';

const listeners = vi.hoisted(() => new Map<string, Set<() => void>>());
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (event: string, callback: () => void) => {
      const callbacks = listeners.get(event) ?? new Set<() => void>();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => callbacks.delete(callback);
    },
  },
}));
const renamed = () => act(() => listeners.get('sessions_changed')?.forEach((fn) => fn()));

vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const sender = '64d8bed3-f73f-8939-8dcf-987cd24fcf6f';
const projection: AgentMessageProjection = {
  direction: 'incoming',
  senderName: sender,
  recipientName: 'Feature chat',
  timestamp: 1793925200000,
  message: {
    messageId: 'c5d70b9d-8b6f-4640-bdf4-a958abb272f6',
    commandId: 'agent-message:names',
    senderConversationId: sender,
    recipientConversationId: 'feature',
    text: 'Keep this message and its delivery state visible.',
    replyTo: null,
    status: 'delivered',
    reason: null,
    sequence: 1,
  },
};
function metadata(summary: string) {
  return { ok: true, json: async () => ({ sessionId: sender, summary }) } as Response;
}

it('resolves a recorded UUID to the current chat name and follows renames', async () => {
  vi.mocked(apiFetch).mockResolvedValue(metadata('PR coordinator'));
  render(<AgentMessageCard projection={projection} />);
  expect(screen.getByRole('link').textContent).not.toContain(sender);
  expect(await screen.findByRole('link', { name: 'PR coordinator' })).toBeTruthy();
  expect(screen.getByRole('link').getAttribute('href')).toBe(`/chat/${sender}`);
  vi.mocked(apiFetch).mockResolvedValue(metadata('Renamed coordinator'));
  renamed();
  await screen.findByRole('link', { name: 'Renamed coordinator' });
  expect(screen.getByText(sender)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Delivered to agent');
});

it('resolves outgoing recipients and shares reads across messages from the same chat', async () => {
  vi.mocked(apiFetch).mockResolvedValue(metadata('Coordinator'));
  render(
    <>
      <AgentMessageCard projection={projection} />
      <AgentMessageCard
        projection={{
          ...projection,
          direction: 'outgoing',
          recipientName: sender,
          message: { ...projection.message, recipientConversationId: sender },
        }}
      />
    </>,
  );
  await waitFor(() => expect(screen.getAllByRole('link', { name: 'Coordinator' })).toHaveLength(2));
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('keeps the last known name and delivery state when name refresh fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(apiFetch).mockResolvedValue(metadata('Coordinator'));
  render(<AgentMessageCard projection={projection} />);
  await screen.findByRole('link', { name: 'Coordinator' });
  vi.mocked(apiFetch).mockRejectedValue(new Error('private diagnostic payload'));
  renamed();
  await screen.findByText('Chat name unavailable. Showing the last known name.');
  expect(screen.getByRole('link', { name: 'Coordinator' })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Delivered to agent');
  expect(warn).toHaveBeenCalledWith(
    'Peer chat name could not be loaded',
    expect.objectContaining({
      code: 'peer_chat_name_failed',
      stage: 'metadata_read',
      sessionId: sender,
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private diagnostic payload');
});

it('uses a readable fallback when a chat is missing and retains its exact ID in details', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 404 } as Response);
  render(<AgentMessageCard projection={projection} />);
  await screen.findByRole('link', { name: 'Unavailable chat' });
  expect(screen.getByText(sender)).toBeTruthy();
  expect(screen.getByText(projection.message.text)).toBeTruthy();
});

it('discards a late name read after an authentication change', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<AgentMessageCard projection={projection} />);
  act(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
  await act(async () => finish(metadata('Previous login name')));
  expect(screen.queryByRole('link', { name: 'Previous login name' })).toBeNull();
});

it('does not let a slower pre-rename read replace the newer name', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<AgentMessageCard projection={projection} />);
  vi.mocked(apiFetch).mockResolvedValue(metadata('Renamed coordinator'));
  renamed();
  await screen.findByRole('link', { name: 'Renamed coordinator' });
  await act(async () => finish(metadata('Old coordinator')));
  expect(screen.getByRole('link', { name: 'Renamed coordinator' })).toBeTruthy();
});

it.each(['', '   ', sender])('uses a readable name for unnamed metadata (%s)', async (summary) => {
  vi.mocked(apiFetch).mockResolvedValue(metadata(summary));
  render(<AgentMessageCard projection={projection} />);
  await screen.findByRole('link', { name: 'Untitled chat' });
});
