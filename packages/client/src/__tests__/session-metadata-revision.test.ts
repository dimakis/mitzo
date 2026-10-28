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
