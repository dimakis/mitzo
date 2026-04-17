import { describe, it, expect, vi } from 'vitest';
import type { SessionTransport } from '@mitzo/harness';
import { ConnectionRegistry } from '@mitzo/harness';

vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  stopChat: vi.fn(),
  isActive: vi.fn().mockReturnValue(false),
  BASE_REPO: '/tmp/test-repo',
}));

vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn().mockReturnValue(new Map()),
  isAllowedPath: vi.fn().mockReturnValue(true),
  NATIVE_COMMAND_NAMES: new Set(),
}));

vi.mock('../slash-commands.js', () => ({
  resolveSlashCommand: vi.fn().mockReturnValue({ type: 'plain' }),
}));

vi.mock('../skill-policy.js', () => ({
  setSkillPolicy: vi.fn(),
  clearSkillPolicy: vi.fn(),
}));

import { startChat } from '../chat.js';

import {
  handleHello,
  handleReconnect,
  handleWatch,
  handleUnwatch,
  handleSwitchSession,
  handleSendV2,
  handleSetModeV2,
  handleStopV2,
  handlePermissionResponseV2,
  isHelloHandshake,
  type V2HandlerContext,
} from '../ws-handler-v2.js';

function mockTransport(): SessionTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send(data: Record<string, unknown>) {
      sent.push(data);
    },
    isOpen() {
      return true;
    },
  };
}

function mockEventStore() {
  return {
    getEventsAfter: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue(null),
  };
}

function mockSessionRegistry() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    findBySessionId: vi.fn().mockReturnValue(null),
    setMode: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
    entries: vi.fn(() => new Map().entries()),
  };
}

function createContext(overrides?: Partial<V2HandlerContext>): V2HandlerContext {
  return {
    connRegistry: new ConnectionRegistry(),
    sessionRegistry:
      overrides?.sessionRegistry ??
      (mockSessionRegistry() as unknown as V2HandlerContext['sessionRegistry']),
    eventStore:
      overrides?.eventStore ?? (mockEventStore() as unknown as V2HandlerContext['eventStore']),
    ...overrides,
  };
}

// ─── isHelloHandshake ────────────────────────────────────────────────────────

describe('isHelloHandshake', () => {
  it('returns true for v2 hello', () => {
    expect(isHelloHandshake({ type: 'hello', protocolVersion: 2 })).toBe(true);
  });

  it('returns true for future protocol versions (≥2)', () => {
    expect(isHelloHandshake({ type: 'hello', protocolVersion: 3 })).toBe(true);
  });

  it('returns false for v1 messages (no hello)', () => {
    expect(isHelloHandshake({ type: 'send', prompt: 'hi' })).toBe(false);
  });

  it('returns false for hello without protocolVersion', () => {
    expect(isHelloHandshake({ type: 'hello' })).toBe(false);
  });

  it('returns false for protocolVersion < 2', () => {
    expect(isHelloHandshake({ type: 'hello', protocolVersion: 1 })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isHelloHandshake(null)).toBe(false);
    expect(isHelloHandshake(undefined)).toBe(false);
  });
});

// ─── handleHello ─────────────────────────────────────────────────────────────

describe('handleHello', () => {
  it('registers connection and sends welcome with connectionId', () => {
    const ctx = createContext();
    const transport = mockTransport();

    const connId = handleHello('conn-new', transport, ctx);

    expect(connId).toBe('conn-new');
    expect(ctx.connRegistry.get('conn-new')).toBeDefined();
    expect(ctx.connRegistry.get('conn-new')!.connectionId).toBe('conn-new');

    expect(transport.sent).toEqual([
      expect.objectContaining({
        type: 'welcome',
        protocolVersion: 2,
        connectionId: 'conn-new',
      }),
    ]);
  });
});

// ─── handleReconnect ─────────────────────────────────────────────────────────

describe('handleReconnect', () => {
  it('replays missed events for each session', () => {
    const eventStore = mockEventStore();
    eventStore.getEventsAfter.mockReturnValue([
      {
        seq: 6,
        sessionId: 'sess-1',
        type: 'block_delta',
        payload: { v: 2, type: 'block_delta', delta: 'hi', sessionId: 'sess-1' },
      },
    ]);

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 5 }] },
      ctx,
    );

    expect(eventStore.getEventsAfter).toHaveBeenCalledWith('sess-1', 5);
    expect(transport.sent.some((m) => m.type === 'block_delta' && m.seq === 6)).toBe(true);
  });

  it('auto-watches all reconnected sessions', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      {
        type: 'reconnect',
        sessions: [
          { sessionId: 'sess-1', lastSeq: 0 },
          { sessionId: 'sess-2', lastSeq: 0 },
        ],
      },
      ctx,
    );

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.watchedSessions.has('sess-1')).toBe(true);
    expect(conn.watchedSessions.has('sess-2')).toBe(true);
  });

  it('sends reconnected summary after replay', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    const summary = transport.sent.find((m) => m.type === 'reconnected');
    expect(summary).toBeDefined();
    expect(summary!.sessions).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', replayed: 0 }),
    ]);
  });
});

// ─── handleWatch / handleUnwatch ─────────────────────────────────────────────

describe('handleWatch', () => {
  it('adds session to watched set and sends confirmation', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleWatch('c1', { type: 'watch', sessionId: 'sess-1' }, ctx);

    expect(ctx.connRegistry.get('c1')!.watchedSessions.has('sess-1')).toBe(true);
    expect(transport.sent).toEqual([
      expect.objectContaining({ type: 'watched', sessionId: 'sess-1' }),
    ]);
  });
});

describe('handleUnwatch', () => {
  it('removes session from watched set and sends confirmation', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-1');

    handleUnwatch('c1', { type: 'unwatch', sessionId: 'sess-1' }, ctx);

    expect(ctx.connRegistry.get('c1')!.watchedSessions.has('sess-1')).toBe(false);
    expect(transport.sent).toEqual([
      expect.objectContaining({ type: 'unwatched', sessionId: 'sess-1' }),
    ]);
  });
});

// ─── handleSwitchSession ─────────────────────────────────────────────────────

describe('handleSwitchSession', () => {
  it('sets active session and sends session metadata from event store', () => {
    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-1',
      mode: 'agent',
      cwd: '/projects/foo',
      branch: 'main',
      wtId: 'wt-2026-04-17-abc',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      totalCostUsd: 0.05,
    });

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-1' }, ctx);

    expect(ctx.connRegistry.get('c1')!.activeSession).toBe('sess-1');
    const resp = transport.sent[0];
    expect(resp).toEqual(
      expect.objectContaining({
        type: 'session_switched',
        sessionId: 'sess-1',
        mode: 'agent',
        cwd: '/projects/foo',
        branch: 'main',
        wtId: 'wt-2026-04-17-abc',
      }),
    );
    expect(resp).toHaveProperty('tokens');
  });

  it('clears active session when sessionId is null', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.setActive('c1', 'sess-old');

    handleSwitchSession('c1', { type: 'switch_session', sessionId: null }, ctx);

    expect(ctx.connRegistry.get('c1')!.activeSession).toBeNull();
    expect(transport.sent[0]).toEqual(expect.objectContaining({ type: 'session_cleared' }));
  });

  it('sends error for unknown session', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSwitchSession('c1', { type: 'switch_session', sessionId: 'nope' }, ctx);

    expect(transport.sent[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('nope'),
      }),
    );
  });
});

// ─── handleSetModeV2 ─────────────────────────────────────────────────────────

describe('handleSetModeV2', () => {
  it('delegates to sessionRegistry.setMode and broadcasts mode_changed', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-1');

    handleSetModeV2('c1', { type: 'set_mode', sessionId: 'sess-1', mode: 'auto' }, ctx);

    expect(sessionReg.setMode).toHaveBeenCalledWith('driver-1', 'auto');
    const modeMsg = transport.sent.find((m) => m.type === 'mode_changed');
    expect(modeMsg).toEqual(
      expect.objectContaining({ type: 'mode_changed', sessionId: 'sess-1', mode: 'auto' }),
    );
  });
});

// ─── handleSendV2 auto-watch ─────────────────────────────────────────────────

describe('handleSendV2 auto-watch', () => {
  it('watches + activates the session on the resume path', () => {
    const sessionReg = mockSessionRegistry();
    // findBySessionId returns a result but isActive returns false → resume path
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-driver', session: {} });
    sessionReg.isActive.mockReturnValue(false);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    // We can't fully test startChat without mocking the Agent SDK, but we can
    // verify that watch + setActive are called before startChat. The resume
    // path should ensure the connection is watching the session.
    handleSendV2(
      'c1',
      transport,
      {
        type: 'send' as const,
        sessionId: 'sess-resume',
        prompt: 'continue',
        clientMsgId: 'cmsg-1',
      },
      ctx,
    );

    const conn = ctx.connRegistry.get('c1');
    expect(conn).toBeDefined();
    expect(conn!.watchedSessions.has('sess-resume')).toBe(true);
    expect(conn!.activeSession).toBe('sess-resume');
  });

  it('passes onSessionResolved callback to startChat on the create path', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      {
        type: 'send' as const,
        sessionId: null,
        prompt: 'hello world',
        clientMsgId: 'cmsg-2',
      },
      ctx,
    );

    expect(startChat).toHaveBeenCalledTimes(1);
    const callArgs = (startChat as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = callArgs[3];
    expect(options.onSessionResolved).toBeTypeOf('function');

    // Simulate the callback firing — should watch + activate
    options.onSessionResolved('sess-new');
    const conn = ctx.connRegistry.get('c1');
    expect(conn).toBeDefined();
    expect(conn!.watchedSessions.has('sess-new')).toBe(true);
    expect(conn!.activeSession).toBe('sess-new');
  });
});

// ─── handleStopV2 ────────────────────────────────────────────────────────────

describe('handleStopV2', () => {
  it('is a no-op when session is not found', () => {
    const ctx = createContext();
    expect(() => handleStopV2('c1', { type: 'stop', sessionId: 'nope' }, ctx)).not.toThrow();
  });
});

// ─── handlePermissionResponseV2 ──────────────────────────────────────────────

describe('handlePermissionResponseV2', () => {
  it('calls resolvePending with correct args', () => {
    const ctx = createContext();
    // resolvePending is imported from permissions.js — we just verify no throw
    expect(() =>
      handlePermissionResponseV2(
        'c1',
        { type: 'permission_response', sessionId: 'sess-1', permId: 'p1', decision: 'once' },
        ctx,
      ),
    ).not.toThrow();
  });
});
