import { expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
import { MitzoApiClient } from '../api-client.js';
import { activeSteeringCommandId } from '../command-attribution.js';
import { metadataConnection as channel } from './fixtures/metadata-connection.js';

vi.mock('../sse-connection.js', async () => ({
  SseConnection: (await import('./fixtures/metadata-connection.js')).MetadataTestConnection,
}));

it('hydrates and retires an invisible continuation through the actual API and selected-chat store', async () => {
  const transcript = {
    cursor: 10,
    messages: [],
    current: null,
    currents: [],
    commandStates: [{ messageId: 'internal-continuation', state: 'running', seq: 9 }],
  };
  const fetch = vi.fn(async (url: string) =>
    Response.json(url.includes('/messages') ? transcript : []),
  );
  const store = createMitzoStore({
    transport: { fetch },
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('SSE only');
      },
    },
    sseConfig: { baseUrl: '', fetch },
  });
  await store.getState().switchSession('chat');
  expect(activeSteeringCommandId(store.getState().messages)).toBe('internal-continuation');
  channel.listener({
    type: 'ordinary_command_completed',
    sessionId: 'chat',
    messageId: 'internal-continuation',
    status: 'interrupted',
    seq: 11,
  });
  expect(activeSteeringCommandId(store.getState().messages)).toBeUndefined();
});

it.each([
  { messageId: 'internal', state: 'forged', seq: 9 },
  { messageId: 'internal', state: 'running', seq: 11 },
  { messageId: '', state: 'running', seq: 9 },
])('rejects invalid command metadata before restoring a steering target (%j)', async (command) => {
  const api = new MitzoApiClient(async () =>
    Response.json({
      cursor: 10,
      messages: [],
      current: null,
      commandStates: [command],
    }),
  );
  await expect(api.getSessionTranscript('chat')).rejects.toThrow();
});
