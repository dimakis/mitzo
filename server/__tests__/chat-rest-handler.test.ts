import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { SseTransport } from '../sse-transport.js';
import { createChatRestRouter } from '../chat-rest-handler.js';
import { ConnectionRegistry } from '@mitzo/harness';
import type { V2HandlerContext } from '../ws-handler-v2.js';

// ─── Mock the handler functions ──────────────────────────────────────────────

vi.mock('../ws-handler-v2.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    handleSendV2: vi.fn(),
    handleStopV2: vi.fn(),
    handleInterruptV2: vi.fn(),
    handlePermissionResponseV2: vi.fn(),
    handleSetModeV2: vi.fn(),
    handleWatch: vi.fn(),
    handleUnwatch: vi.fn(),
    handleSwitchSession: vi.fn().mockResolvedValue(undefined),
    handleSessionSuspend: vi.fn(),
    handleSessionClose: vi.fn(),
    handleReconnect: vi.fn(),
  };
});

import {
  handleSendV2,
  handleStopV2,
  handleInterruptV2,
  handlePermissionResponseV2,
  handleSetModeV2,
  handleWatch,
  handleUnwatch,
  handleSwitchSession,
  handleSessionSuspend,
  handleSessionClose,
  handleReconnect,
} from '../ws-handler-v2.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockResponse() {
  return {
    write: vi.fn(() => true),
    end: vi.fn(),
    writableEnded: false,
  } as unknown as import('express').Response;
}

function buildApp(sseRegistry: SessionSseRegistry, connRegistry: ConnectionRegistry) {
  const ctx: V2HandlerContext = {
    connRegistry,
    sessionRegistry: {} as V2HandlerContext['sessionRegistry'],
    eventStore: {} as V2HandlerContext['eventStore'],
    nativeCommands: {} as V2HandlerContext['nativeCommands'],
  };

  const app = express();
  app.use(express.json());
  app.use('/api/chat', createChatRestRouter(sseRegistry, ctx));
  return { app, ctx };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('chat-rest-handler', () => {
  let sseRegistry: SessionSseRegistry;
  let connRegistry: ConnectionRegistry;
  let testApp: express.Express;
  const CONNECTION_ID = 'conn-test-123';

  beforeEach(() => {
    vi.clearAllMocks();
    sseRegistry = new SessionSseRegistry();
    connRegistry = new ConnectionRegistry();

    // Register an SSE stream + connection
    const res = mockResponse();
    sseRegistry.add(CONNECTION_ID, res);
    const transport = new SseTransport(CONNECTION_ID, sseRegistry);
    connRegistry.register(CONNECTION_ID, transport);

    const { app } = buildApp(sseRegistry, connRegistry);
    testApp = app;
  });

  afterEach(() => {
    sseRegistry.destroy();
    connRegistry.dispose();
  });

  // ─── Header validation ──────────────────────────────────────────────────

  it('rejects requests without X-Connection-ID', async () => {
    const res = await request(testApp)
      .post('/api/chat/send')
      .send({ prompt: 'hello', clientMsgId: 'msg-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('X-Connection-ID');
  });

  it('rejects requests with unknown connection', async () => {
    const res = await request(testApp)
      .post('/api/chat/send')
      .set('X-Connection-ID', 'conn-nonexistent')
      .send({ prompt: 'hello', clientMsgId: 'msg-1' });

    expect(res.status).toBe(404);
  });

  // ─── POST /api/chat/send ────────────────────────────────────────────────

  it('POST /send calls handleSendV2 and returns 202', async () => {
    const res = await request(testApp)
      .post('/api/chat/send')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({
        type: 'send',
        sessionId: null,
        prompt: 'hello world',
        clientMsgId: 'msg-1',
      });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(handleSendV2).toHaveBeenCalledOnce();
    expect(handleSendV2).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.any(SseTransport),
      expect.objectContaining({ prompt: 'hello world' }),
      expect.any(Object),
    );
  });

  // ─── POST /api/chat/stop ────────────────────────────────────────────────

  it('POST /stop calls handleStopV2', async () => {
    const res = await request(testApp)
      .post('/api/chat/stop')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({ type: 'stop', sessionId: 'sess-1' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(handleStopV2).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/interrupt ───────────────────────────────────────────

  it('POST /interrupt calls handleInterruptV2', async () => {
    const res = await request(testApp)
      .post('/api/chat/interrupt')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({
        type: 'interrupt',
        sessionId: 'sess-1',
        prompt: 'stop that',
        clientMsgId: 'msg-int-1',
      });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(handleInterruptV2).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/permission ──────────────────────────────────────────

  it('POST /permission calls handlePermissionResponseV2', async () => {
    const res = await request(testApp)
      .post('/api/chat/permission')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({
        type: 'permission_response',
        permId: 'perm-1',
        decision: 'once',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(handlePermissionResponseV2).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/mode ───────────────────────────────────────────────

  it('POST /mode calls handleSetModeV2', async () => {
    const res = await request(testApp)
      .post('/api/chat/mode')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({
        type: 'set_mode',
        sessionId: 'sess-1',
        mode: 'agent',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(handleSetModeV2).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/watch + unwatch ─────────────────────────────────────

  it('POST /watch calls handleWatch', async () => {
    const res = await request(testApp)
      .post('/api/chat/watch')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({ type: 'watch', sessionId: 'sess-1' });

    expect(res.status).toBe(200);
    expect(handleWatch).toHaveBeenCalledOnce();
  });

  it('POST /unwatch calls handleUnwatch', async () => {
    const res = await request(testApp)
      .post('/api/chat/unwatch')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({ type: 'unwatch', sessionId: 'sess-1' });

    expect(res.status).toBe(200);
    expect(handleUnwatch).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/switch ──────────────────────────────────────────────

  it('POST /switch calls handleSwitchSession', async () => {
    const res = await request(testApp)
      .post('/api/chat/switch')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({ type: 'switch_session', sessionId: 'sess-1' });

    expect(res.status).toBe(200);
    expect(handleSwitchSession).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/suspend ─────────────────────────────────────────────

  it('POST /suspend calls handleSessionSuspend', async () => {
    const res = await request(testApp)
      .post('/api/chat/suspend')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({
        type: 'session_suspend',
        sessions: [{ sessionId: 'sess-1', lastSeq: 42 }],
      });

    expect(res.status).toBe(200);
    expect(handleSessionSuspend).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/close ──────────────────────────────────────────────

  it('POST /close calls handleSessionClose', async () => {
    const res = await request(testApp)
      .post('/api/chat/close')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({ type: 'session_close', sessionId: 'sess-1' });

    expect(res.status).toBe(200);
    expect(handleSessionClose).toHaveBeenCalledOnce();
  });

  // ─── POST /api/chat/reconnect ──────────────────────────────────────────

  it('POST /reconnect calls handleReconnect', async () => {
    const res = await request(testApp)
      .post('/api/chat/reconnect')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({
        sessions: [
          { sessionId: 'sess-1', lastSeq: 10 },
          { sessionId: 'sess-2', lastSeq: 20 },
        ],
      });

    expect(res.status).toBe(200);
    expect(handleReconnect).toHaveBeenCalledOnce();
    expect(handleReconnect).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.objectContaining({
        type: 'reconnect',
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: 'sess-1', lastSeq: 10 }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it('POST /reconnect rejects missing sessions array', async () => {
    const res = await request(testApp)
      .post('/api/chat/reconnect')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sessions');
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  it('returns 500 when handler throws', async () => {
    (handleStopV2 as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('SDK crashed');
    });

    const res = await request(testApp)
      .post('/api/chat/stop')
      .set('X-Connection-ID', CONNECTION_ID)
      .send({ type: 'stop', sessionId: 'sess-1' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});
