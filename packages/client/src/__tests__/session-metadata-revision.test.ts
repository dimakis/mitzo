import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
import { metadataConnection as channel } from './fixtures/metadata-connection.js';
vi.mock('../sse-connection.js', async () => ({
  SseConnection: (await import('./fixtures/metadata-connection.js')).MetadataTestConnection,
}));
async function fixture() {
  const fetch = vi.fn(async () => Response.json([]));
  const store = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('Inert SSE only');
      },
    },
    sseConfig: { baseUrl: '', fetch },
  });
  await store.getState().switchSession('selected-chat');
  return store;
}
it('invalidates selected metadata for same-branch workspace notifications while filtering another chat', async () => {
  const store = await fixture();
  channel.listener({
    type: 'session_info',
    sessionId: 'selected-chat',
    branch: 'same-branch',
    cwd: '/old-task',
    worktree: false,
  });
  const previous = store.getState().sessionMetadataRevision;
  expect(store.getState().isSessionMetadataCurrent('selected-chat', previous)).toBe(true);
  channel.listener({
    type: 'session_info',
    sessionId: 'other-chat',
    branch: 'foreign',
    cwd: '/foreign',
    worktree: false,
  });
  expect(store.getState().sessionMetadataRevision).toBe(previous);
  channel.listener({
    type: 'session_info',
    sessionId: 'selected-chat',
    branch: 'same-branch',
    cwd: '/adopted-task',
    worktree: false,
  });
  expect(store.getState().sessionMetadataRevision).toBe(previous + 1);
  expect(store.getState().messages.branch).toBe('same-branch');
  expect(store.getState().isSessionMetadataCurrent('selected-chat', previous)).toBe(false);
});
it.each(['_open', '_foreground', 'session_reconnect_snapshot'])(
  'refreshes selected workspace identity after a missed live event on %s',
  async (type) => {
    const store = await fixture();
    const previous = store.getState().sessionMetadataRevision;
    channel.listener({
      type,
      ...(type === 'session_reconnect_snapshot'
        ? { sessionId: 'selected-chat', cursor: 0, cursorValid: true }
        : {}),
    });
    expect(store.getState().sessionMetadataRevision).toBe(previous + 1);
    expect(store.getState().isSessionMetadataCurrent('selected-chat', previous)).toBe(false);
  },
);
it.each([
  { type: 'session_end' },
  { type: 'ordinary_command_completed', messageId: 'command', status: 'completed' },
  ...['completed', 'ended', 'interrupted', 'failed', 'cancelled'].map((commandState) => ({
    type: 'ordinary_command_state',
    messageId: 'command',
    commandState,
  })),
])('refreshes continuation eligibility after selected command completion: %j', async (event) => {
  const store = await fixture();
  const previous = store.getState().sessionMetadataRevision;
  channel.listener({ ...event, sessionId: 'other-chat' });
  expect(store.getState().sessionMetadataRevision).toBe(previous);
  channel.listener({ ...event, sessionId: 'selected-chat' });
  expect(store.getState().sessionMetadataRevision).toBe(previous + 1);
  expect(store.getState().isSessionMetadataCurrent('selected-chat', previous)).toBe(false);
});
it('does not refetch continuation metadata for streaming progress or queued commands', async () => {
  const store = await fixture();
  const previous = store.getState().sessionMetadataRevision;
  for (const commandState of ['sending', 'queued', 'running'])
    channel.listener({
      type: 'ordinary_command_state',
      sessionId: 'selected-chat',
      messageId: 'command',
      commandState,
    });
  expect(store.getState().sessionMetadataRevision).toBe(previous);
});
it('invalidates only the selected conversation after an explicit recovery action', async () => {
  const store = await fixture();
  const before = store.getState().sessionMetadataRevision;
  store.getState().invalidateSessionMetadata('other-chat');
  expect(store.getState().sessionMetadataRevision).toBe(before);
  store.getState().invalidateSessionMetadata('selected-chat');
  expect(store.getState().isSessionMetadataCurrent('selected-chat', before)).toBe(false);
  expect(store.getState().sessionMetadataRevision).toBe(before + 1);
});
