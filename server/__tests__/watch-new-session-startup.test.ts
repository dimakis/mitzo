import { writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionRegistry, SessionRegistry, type SessionTransport } from '@mitzo/harness';
import { V2SendMessage } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { runQueryLoop } from '../query-loop.js';
import { handleSendV2, type V2HandlerContext } from '../ws-handler-v2.js';
import { startChat } from '../chat.js';

// Only provider/boot and unrelated external side effects are mocked. The handler,
// query translator, durable event store and watcher fan-out below remain real.
vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  preflightStartupProviderCommand: vi.fn(() => false),
  preflightChatCommand: vi.fn(() => false),
  nativeStartupSessionId: vi.fn((id: string) => `mock-startup-${id}`),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  stopChat: vi.fn(),
  closeSessionByUser: vi.fn(),
  isActive: vi.fn(() => false),
  reattachChat: vi.fn(),
  BASE_REPO: '/offline/mock-repository',
}));
vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn(() => new Map()),
  isAllowedPath: vi.fn(() => true),
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('../slash-commands.js', () => ({
  resolveSlashCommand: vi.fn(() => ({ type: 'passthrough' })),
}));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(),
  deriveGoalTitle: vi.fn((prompt: string) => prompt),
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn() }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn() }));
vi.mock('../notification-center.js', () => ({
  recordTurnNotification: vi.fn(() => null),
  recordTurnFailureNotification: vi.fn(() => null),
}));

const request = {
  type: 'send' as const,
  sessionId: null,
  clientMsgId: 'afcb2114-dc2b-4cf7-a79b-4b591130ea9b',
  prompt: 'Offline Watch startup fixture',
};
const mainSession = '7d7d9254-e443-4984-ab54-66972791323b';
const foreignSession = '795372e7-e336-49ef-8c0b-114a917d59f4';
const reply = 'Mocked startup reply.';

/** Fake SDK only; normalized client packets are never fabricated by the test. */
async function* sdkEvents(sessionId: string) {
  yield { type: 'assistant', session_id: sessionId, message: { content: [] } };
  yield {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'mock-assistant' } },
  };
  yield {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  };
  yield {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
  };
  yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
  yield { type: 'assistant', session_id: sessionId, message: { content: [] } };
  yield { type: 'result', session_id: sessionId, is_error: false };
}

function captureTransport(): SessionTransport & { packets: string[] } {
  const packets: string[] = [];
  return { packets, isOpen: () => true, send: (data) => packets.push(JSON.stringify(data)) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('captures the actual nil-account Watch startup assignment and exact first echo through watcher fan-out', async () => {
  const fetch = vi.fn(() => {
    throw Error('Live network is forbidden in the offline startup fixture');
  });
  vi.stubGlobal('fetch', fetch);
  const store = new EventStore(':memory:');
  const sessions = new SessionRegistry();
  const connections = new ConnectionRegistry();
  const main = captureTransport();
  const foreign = captureTransport();
  connections.register('watch-main', main);
  connections.register('watch-foreign', foreign);
  const context: V2HandlerContext = {
    connRegistry: connections,
    sessionRegistry: sessions,
    eventStore: store,
    nativeCommands: { execute: vi.fn() } as unknown as V2HandlerContext['nativeCommands'],
  };
  const driverCalls: Array<{ connection: string | undefined; type: unknown }> = [];
  let completed: Promise<void> | undefined;
  vi.mocked(startChat).mockImplementation(async (transport, clientId, prompt, options) => {
    expect(options.accountId).toBeUndefined();
    expect(options.resume).toBeUndefined();
    const abortController = new AbortController();
    sessions.register(clientId, {
      transport,
      abortController,
      sessionAllowList: new Set(),
      mode: options.mode ?? 'agent',
    });
    const send = transport.send.bind(transport);
    vi.spyOn(transport, 'send').mockImplementation((event) => {
      driverCalls.push({ connection: options.operatorConnectionId, type: event.type });
      send(event);
    });
    options.onStartupAdmission?.();
    // This is the legacy SDK forwarding contract in chat.ts: nil account/resume
    // supplies the initial prompt, exact command UUID and resolution callback.
    completed = runQueryLoop(
      sdkEvents(options.operatorConnectionId === 'watch-main' ? mainSession : foreignSession),
      clientId,
      sessions,
      abortController,
      store,
      prompt,
      {
        connRegistry: connections,
        initialClientMsgId: options.clientMsgId,
        onSessionResolved: options.onSessionResolved,
      },
    );
    await completed;
  });
  try {
    const parsedRequest = V2SendMessage.parse(request);
    expect(parsedRequest).toEqual(request);
    await handleSendV2('watch-main', main, parsedRequest, context);
    expect(startChat).toHaveBeenCalledTimes(1);
    await completed;
    const packets = main.packets.map((packet) => JSON.parse(packet) as Record<string, unknown>);
    const assignment = packets.find((packet) => packet.type === 'session_id')!;
    const firstEcho = packets.find((packet) => packet.type === 'user_message')!;
    expect(assignment).toEqual({ type: 'session_id', sessionId: mainSession });
    expect(assignment).not.toHaveProperty('clientMsgId');
    expect(firstEcho).toMatchObject({
      v: 2,
      type: 'user_message',
      sessionId: mainSession,
      messageId: request.clientMsgId,
      text: request.prompt,
      seq: expect.any(Number),
    });
    expect(packets.indexOf(assignment)).toBeLessThan(packets.indexOf(firstEcho));
    expect(packets.filter((packet) => packet.type === 'user_message')).toHaveLength(1);
    expect(packets.some((packet) => packet.type === 'block_delta' && packet.delta === reply)).toBe(
      true,
    );
    expect(
      store.getSessionEvents(mainSession).find((event) => event.type === 'user_message')?.payload,
    ).toMatchObject({
      messageId: request.clientMsgId,
      sessionId: mainSession,
      text: request.prompt,
    });
    expect(connections.get('watch-main')?.watchedSessions.has(mainSession)).toBe(true);
    // Real watcher registration precedes assignment; the enriched startup
    // transport is never called, so it cannot add clientMsgId to this packet.
    expect(driverCalls).toEqual([]);

    const mainPackets = [...main.packets];
    // A second fake SDK conversation exercises the same message-ID/different-SID
    // boundary. Real watcher membership must not fan it into the main connection.
    await handleSendV2('watch-foreign', foreign, parsedRequest, context);
    await completed;
    const foreignEcho = foreign.packets
      .map((packet) => JSON.parse(packet) as Record<string, unknown>)
      .find((packet) => packet.type === 'user_message')!;
    expect(foreignEcho).toMatchObject({
      sessionId: foreignSession,
      messageId: request.clientMsgId,
    });
    expect(main.packets).toEqual(mainPackets);
    expect(connections.get('watch-main')?.watchedSessions.has(foreignSession)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    const output = process.env.MITZO_WATCH_STARTUP_FIXTURE_OUTPUT;
    if (output)
      writeFileSync(
        output,
        JSON.stringify({ request, events: main.packets, foreignEvents: foreign.packets }, null, 2) +
          '\n',
      );
  } finally {
    for (const [clientId] of sessions.entries()) sessions.remove(clientId);
    connections.remove('watch-main');
    connections.remove('watch-foreign');
    store.close();
  }
});
