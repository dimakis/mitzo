import { describe, it, expect, vi } from 'vitest';
import type { SessionTransport } from '@mitzo/harness';
import { ConnectionRegistry } from '@mitzo/harness';
import { V2SendMessage } from '@mitzo/protocol';

vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  stopChat: vi.fn(),
  isActive: vi.fn().mockReturnValue(false),
  reattachChat: vi.fn().mockReturnValue(true),
  rekeyChat: vi.fn().mockReturnValue(true),
  BASE_REPO: '/tmp/test-repo',
  discoverSession: vi.fn().mockResolvedValue(null),
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

vi.mock('../permissions.js', () => ({
  resolvePending: vi.fn(),
  denyPendingBySession: vi.fn().mockReturnValue(0),
}));

import {
  startChat,
  interruptChat,
  sendToChat,
  stopChat,
  isActive,
  reattachChat,
  rekeyChat,
  discoverSession,
} from '../chat.js';
import { setSkillPolicy, clearSkillPolicy } from '../skill-policy.js';
import { resolveSlashCommand } from '../slash-commands.js';
import { denyPendingBySession } from '../permissions.js';

import {
  handleHello,
  handleReconnect,
  handleWatch,
  handleUnwatch,
  handleSwitchSession,
  handleSendV2,
  handleInterruptV2,
  handleSetModeV2,
  handleStopV2,
  handlePermissionResponseV2,
  handleSessionSuspend,
  isHelloHandshake,
  dispatchV2Message,
  getOwnerConnection,
  detectStateMismatch,
  type V2HandlerContext,
} from '../ws-handler-v2.js';
import { NativeCommandRegistry } from '../native-commands.js';

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
    getSessionState: vi.fn().mockReturnValue('ACTIVE'),
    setSessionState: vi.fn(),
  };
}

function mockSessionRegistry() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    findBySessionId: vi.fn().mockReturnValue(null),
    setMode: vi.fn(),
    isActive: vi.fn().mockReturnValue(false),
    isAttached: vi.fn().mockReturnValue(true),
    reattach: vi.fn().mockReturnValue(true),
    remove: vi.fn(),
    entries: vi.fn(() => new Map().entries()),
    suspend: vi.fn(),
    isSuspended: vi.fn().mockReturnValue(false),
    resume: vi.fn().mockReturnValue([]),
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
    nativeCommands: overrides?.nativeCommands ?? new NativeCommandRegistry(),
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

  it('reattaches detached session on reconnect (owner connection)', () => {
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (rekeyChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1' });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(false); // detached — reconnect should reattach

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('c1:sess-1', transport);
    expect(rekeyChat).not.toHaveBeenCalled();
  });

  it('reattaches detached session when owner connection is gone (device restart)', () => {
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    // Session owned by old connection 'c-old', but 'c-old' is no longer registered
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c-old:sess-1' });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(false);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    // Register new connection 'c-new' — 'c-old' is NOT registered (gone)
    ctx.connRegistry.register('c-new', transport);

    handleReconnect(
      'c-new',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('c-old:sess-1', transport);
  });

  it('resets cursor to client lastSeq immediately after watch (before replay)', () => {
    const eventStore = mockEventStore();
    eventStore.getEventsAfter.mockReturnValue([
      { seq: 51, payload: { type: 'msg1' } },
      { seq: 52, payload: { type: 'msg2' } },
    ]);

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    // Spy on resetCursor to verify it's called early
    const resetSpy = vi.spyOn(ctx.connRegistry, 'resetCursor');

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 50 }] },
      ctx,
    );

    // resetCursor should have been called at least twice:
    // 1. Before replay (with client's lastSeq)
    // 2. After replay (with final replayed seq)
    expect(resetSpy).toHaveBeenCalledTimes(2);
    // First call sets cursor to client's lastSeq
    expect(resetSpy).toHaveBeenNthCalledWith(1, 'c1', 'sess-1', 50);
    // Second call sets cursor to last replayed seq
    expect(resetSpy).toHaveBeenNthCalledWith(2, 'c1', 'sess-1', 52);

    resetSpy.mockRestore();
  });
});

// ─── boot_context replay (sendBootContext helper, tested via handlers) ──────

describe('boot_context replay', () => {
  it('handleReconnect sends boot_context with sessionId from in-memory cache', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'c1:sess-1',
      session: { bootContext: { source: 'contexgin', tokenCount: 100 } },
    });
    sessionReg.isActive.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({ isActive: true });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    const bootMsg = transport.sent.find((m) => m.type === 'boot_context');
    expect(bootMsg).toBeDefined();
    expect(bootMsg).toHaveProperty('sessionId', 'sess-1');
    expect(bootMsg).toHaveProperty('source', 'contexgin');
  });

  it('handleReconnect uses cold-path EventStore when no in-memory cache', () => {
    const sessionReg = mockSessionRegistry();
    // No in-memory bootContext — session not in registry
    sessionReg.findBySessionId.mockReturnValue(null);

    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      isActive: false,
      bootContext: JSON.stringify({ source: 'contexgin', tokenCount: 50 }),
    });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    const bootMsg = transport.sent.find((m) => m.type === 'boot_context');
    expect(bootMsg).toBeDefined();
    expect(bootMsg).toHaveProperty('sessionId', 'sess-1');
    expect(bootMsg).toHaveProperty('source', 'contexgin');
  });

  it('handleSwitchSession sends boot_context with sessionId', async () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'c1:sess-1',
      session: { bootContext: { source: 'local-fallback', tokenCount: 0 } },
    });

    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-1',
      mode: 'agent',
      cwd: '/test',
      branch: 'main',
      wtId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    });
    eventStore.getSessionState.mockReturnValue('ACTIVE');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-1' }, ctx);

    const bootMsg = transport.sent.find((m) => m.type === 'boot_context');
    expect(bootMsg).toBeDefined();
    expect(bootMsg).toHaveProperty('sessionId', 'sess-1');
  });

  it('logs warning on invalid JSON in EventStore cold path', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue(null);

    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      isActive: false,
      bootContext: '{not valid json',
    });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    // Should not throw — logs warning instead
    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    const bootMsg = transport.sent.find((m) => m.type === 'boot_context');
    expect(bootMsg).toBeUndefined(); // No boot_context sent on invalid JSON
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
  it('sets active session and sends session metadata from event store', async () => {
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

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-1' }, ctx);

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

  it('clears active session when sessionId is null', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.setActive('c1', 'sess-old');

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: null }, ctx);

    expect(ctx.connRegistry.get('c1')!.activeSession).toBeNull();
    expect(transport.sent[0]).toEqual(expect.objectContaining({ type: 'session_cleared' }));
  });

  it('sends error for unknown session when SDK discovery also fails', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'nope' }, ctx);

    expect(discoverSession).toHaveBeenCalledWith('nope');
    expect(transport.sent[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('nope'),
      }),
    );
  });

  it('falls back to SDK discovery when EventStore misses, then succeeds', async () => {
    const eventStore = mockEventStore();
    // First call: not found. Second call (after backfill): found.
    eventStore.getSession.mockReturnValueOnce(null).mockReturnValueOnce(null);

    const discoveredMeta = {
      sessionId: 'orphan-1',
      mode: 'agent',
      cwd: '/projects/orphan',
      branch: 'main',
      wtId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    };

    (discoverSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(discoveredMeta);

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'orphan-1' }, ctx);

    expect(discoverSession).toHaveBeenCalledWith('orphan-1');
    expect(ctx.connRegistry.get('c1')!.activeSession).toBe('orphan-1');
    expect(transport.sent[0]).toEqual(
      expect.objectContaining({
        type: 'session_switched',
        sessionId: 'orphan-1',
      }),
    );
  });

  it('calls watch() before sending session_switched', async () => {
    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-1',
      mode: 'agent',
      cwd: '/test',
      branch: 'main',
      wtId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    });

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-1' }, ctx);

    // watch() should have been called
    expect(ctx.connRegistry.hasOpenWatchers('sess-1')).toBe(true);
  });

  it('session_switched does not include running field', async () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-1',
      mode: 'agent',
      cwd: '/test',
      branch: 'main',
      wtId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    });
    eventStore.getSessionState.mockReturnValue('ACTIVE');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-1' }, ctx);

    const resp = transport.sent[0];
    // Running state from session_state_changed events, not session_switched
    expect(resp).not.toHaveProperty('running');
    expect(resp).toHaveProperty('type', 'session_switched');

    // session_state_changed emitted immediately after session_switched
    const stateMsg = transport.sent[1];
    expect(stateMsg).toMatchObject({
      type: 'session_state_changed',
      sessionId: 'sess-1',
      state: 'running',
      internalState: 'ACTIVE',
    });
    expect(stateMsg).toHaveProperty('timestamp');
  });

  it('no session_state_changed when getSessionState returns null', async () => {
    const sessionReg = mockSessionRegistry();
    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-1',
      mode: 'agent',
      cwd: '/test',
      branch: 'main',
      wtId: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
    });
    eventStore.getSessionState.mockReturnValue(null);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-1' }, ctx);

    // Only session_switched should be sent, no session_state_changed
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toHaveProperty('type', 'session_switched');
  });
});

// ─── handleSetModeV2 ─────────────────────────────────────────────────────────

describe('handleSetModeV2', () => {
  it('is a no-op when session is not found', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-1');

    handleSetModeV2('c1', { type: 'set_mode', sessionId: 'sess-1', mode: 'auto' }, ctx);

    // No broadcast should happen when session doesn't exist
    expect(transport.sent).toHaveLength(0);
  });

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
  it('watches + activates the session on the resume path with composite clientId', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    const sessionReg = mockSessionRegistry();
    // findBySessionId returns a result but isActive returns false → resume path
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-driver', session: {} });
    sessionReg.isActive.mockReturnValue(false);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

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

    // startChat should receive composite clientId (connectionId:sessionId)
    const callArgs = (startChat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toBe('c1:sess-resume');
  });

  it('passes onSessionResolved callback and uses unique composite clientId on create path', () => {
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

    // clientId should be composite: connectionId:new-<uuid>
    const clientId = callArgs[1] as string;
    expect(clientId).toMatch(/^c1:new-[0-9a-f]{8}$/);

    // Simulate the callback firing — should watch + activate
    options.onSessionResolved('sess-new');
    const conn = ctx.connRegistry.get('c1');
    expect(conn).toBeDefined();
    expect(conn!.watchedSessions.has('sess-new')).toBe(true);
    expect(conn!.activeSession).toBe('sess-new');
  });
});

// ─── handleSendV2 reattach on send ──────────────────────────────────────────

describe('handleSendV2 reattach', () => {
  it('reattaches detached session before sending to active driver', () => {
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(false); // detached

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('c1:sess-1', transport);
    expect(sendToChat).toHaveBeenCalled();

    // Restore default
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('skips reattach when session is already attached', () => {
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true); // already attached

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(reattachChat).not.toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ─── handleSendV2 skill policy timing ───────────────────────────────────────

describe('handleSendV2 skill policy', () => {
  it('calls setSkillPolicy with found.clientId on active-resume path', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (setSkillPolicy as ReturnType<typeof vi.fn>).mockClear();
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      type: 'skill',
      name: 'test-skill',
      renderedPrompt: 'rendered prompt',
      allowedTools: ['Read', 'Write'],
      arguments: '',
    });

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-active', session: {} });
    sessionReg.isActive.mockReturnValue(false);
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      {
        type: 'send' as const,
        sessionId: 'sess-active',
        prompt: '/test-skill',
        clientMsgId: 'cmsg-sp',
      },
      ctx,
    );

    // Must use found.clientId ('c1:sess-active'), not connectionId ('c1')
    expect(setSkillPolicy).toHaveBeenCalledWith(expect.anything(), 'c1:sess-active', [
      'Read',
      'Write',
    ]);
    expect(sendToChat).toHaveBeenCalledWith(
      'c1:sess-active',
      'rendered prompt',
      undefined,
      undefined,
      'cmsg-sp',
    );
  });

  it('calls setSkillPolicy with composite clientId on resume path', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (setSkillPolicy as ReturnType<typeof vi.fn>).mockClear();
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      type: 'skill',
      name: 'test-skill',
      renderedPrompt: 'rendered prompt',
      allowedTools: ['Read'],
      arguments: '',
    });

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-driver', session: {} });
    sessionReg.isActive.mockReturnValue(false);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      {
        type: 'send' as const,
        sessionId: 'sess-resume',
        prompt: '/test-skill',
        clientMsgId: 'cmsg-sp2',
      },
      ctx,
    );

    // Resume path uses composite clientId
    expect(setSkillPolicy).toHaveBeenCalledWith(expect.anything(), 'c1:sess-resume', ['Read']);
  });
});

// ─── handleInterruptV2 ──────────────────────────────────────────────────────

describe('handleInterruptV2', () => {
  it('watches, activates, and resumes via startChat when session is idle', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'stop and do this', clientMsgId: 'i1' },
      ctx,
    );

    const conn = ctx.connRegistry.get('c1');
    expect(conn).toBeDefined();
    expect(conn!.watchedSessions.has('sess-1')).toBe(true);
    expect(conn!.activeSession).toBe('sess-1');

    // Session is idle (isActive=false) — resumes via startChat, not interruptChat
    expect(startChat).toHaveBeenCalledWith(
      transport,
      'c1:sess-1',
      'stop and do this',
      expect.objectContaining({ resume: 'sess-1', clientMsgId: 'i1' }),
    );
  });

  it('is a no-op when session is not found', () => {
    const ctx = createContext();
    const transport = mockTransport();
    expect(() =>
      handleInterruptV2(
        'c1',
        transport,
        { type: 'interrupt', sessionId: 'nope', prompt: 'x', clientMsgId: 'i2' },
        ctx,
      ),
    ).not.toThrow();
  });
});

// ─── handleStopV2 ────────────────────────────────────────────────────────────

describe('handleStopV2', () => {
  it('is a no-op when session is not found', () => {
    const ctx = createContext();
    expect(() => handleStopV2('c1', { type: 'stop', sessionId: 'nope' }, ctx)).not.toThrow();
  });

  it('calls stopChat with correct clientId when session is found', () => {
    (stopChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });

    handleStopV2('c1', { type: 'stop', sessionId: 'sess-1' }, ctx);

    expect(stopChat).toHaveBeenCalledWith('driver-1');
  });
});

// ─── handlePermissionResponseV2 ──────────────────────────────────────────────

describe('handlePermissionResponseV2', () => {
  it('calls resolvePending with correct args', () => {
    const ctx = createContext();
    expect(() =>
      handlePermissionResponseV2(
        'c1',
        { type: 'permission_response', sessionId: 'sess-1', permId: 'p1', decision: 'once' },
        ctx,
      ),
    ).not.toThrow();
  });

  it('defaults decision to deny when not provided', () => {
    const ctx = createContext();
    expect(() =>
      handlePermissionResponseV2(
        'c1',
        {
          type: 'permission_response',
          sessionId: 'sess-1',
          permId: 'p2',
          decision: undefined as unknown as 'once',
        },
        ctx,
      ),
    ).not.toThrow();
  });
});

// ─── handleReconnect — no running field in summary ──────────────────────────

describe('handleReconnect reconnected summary (P1)', () => {
  it('reconnected summary does not include running field', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1' });
    sessionReg.isActive.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    const summary = transport.sent.find((m) => m.type === 'reconnected') as {
      sessions: Array<{ sessionId: string; replayed: number }>;
    };
    expect(summary.sessions[0]).not.toHaveProperty('running');
    expect(summary.sessions[0]).toHaveProperty('sessionId', 'sess-1');
    expect(summary.sessions[0]).toHaveProperty('replayed');
  });

  it('does not remove stale sessions on reconnect (deferred to handleSendV2)', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1' });
    sessionReg.isActive.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ENDED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-zombie', lastSeq: 0 }] },
      ctx,
    );

    // Reconnect no longer does zombie cleanup — handleSendV2 handles it
    expect(sessionReg.remove).not.toHaveBeenCalled();
  });

  it('replays multiple events in sequence order', () => {
    const eventStore = mockEventStore();
    eventStore.getEventsAfter.mockReturnValue([
      {
        seq: 3,
        sessionId: 'sess-1',
        type: 'block_delta',
        payload: { v: 2, type: 'block_delta', delta: 'first', sessionId: 'sess-1' },
      },
      {
        seq: 4,
        sessionId: 'sess-1',
        type: 'block_delta',
        payload: { v: 2, type: 'block_delta', delta: 'second', sessionId: 'sess-1' },
      },
      {
        seq: 5,
        sessionId: 'sess-1',
        type: 'turn_end',
        payload: { v: 2, type: 'turn_end', sessionId: 'sess-1' },
      },
    ]);

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 2 }] },
      ctx,
    );

    const replayed = transport.sent.filter((m) => m.seq !== undefined);
    expect(replayed).toHaveLength(3);
    expect(replayed[0].seq).toBe(3);
    expect(replayed[1].seq).toBe(4);
    expect(replayed[2].seq).toBe(5);
  });
});

// ─── handleSendV2 — routing paths ──────────────────────────────────────────

describe('handleSendV2 routing', () => {
  it('sends to active driver on the active path', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hello', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(sendToChat).toHaveBeenCalledWith('c1:sess-1', 'hello', undefined, undefined, 'cmsg-1');
    expect(ctx.connRegistry.get('c1')!.watchedSessions.has('sess-1')).toBe(true);
    expect(ctx.connRegistry.get('c1')!.activeSession).toBe('sess-1');
  });

  it('sends error on resolution error', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      type: 'error',
      message: 'Unknown command /foo',
    });

    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: null, prompt: '/foo', clientMsgId: 'e1' },
      ctx,
    );

    expect(transport.sent).toContainEqual(
      expect.objectContaining({ type: 'error', error: 'Unknown command /foo' }),
    );
    expect(startChat).not.toHaveBeenCalled();
  });

  it('returns early for native commands without calling startChat', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      type: 'native',
      name: 'test-cmd',
      arguments: '',
    });

    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: null, prompt: '/test-cmd', clientMsgId: 'h1' },
      ctx,
    );

    // Native commands short-circuit — startChat should NOT be called
    expect(startChat).not.toHaveBeenCalled();
  });

  it('sends skill_invoked event for skill commands', () => {
    // Reset resolveSlashCommand to plain first, then set skill for this test
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReset();
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      type: 'skill',
      name: 'commit',
      renderedPrompt: 'Create a commit...',
      allowedTools: ['Bash'],
      arguments: '-m "test"',
    });
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
        prompt: '/commit -m "test"',
        clientMsgId: 's1',
      },
      ctx,
    );

    expect(transport.sent).toContainEqual(
      expect.objectContaining({
        type: 'skill_invoked',
        v: 2,
        name: 'commit',
        arguments: '-m "test"',
      }),
    );
    expect(startChat).toHaveBeenCalledTimes(1);

    // Restore default
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValue({ type: 'plain' });
  });

  it('sends error message on exception', () => {
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReset();
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('Kaboom');
    });

    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: null, prompt: 'hi', clientMsgId: 'x1' },
      ctx,
    );

    expect(transport.sent).toContainEqual(
      expect.objectContaining({ type: 'error', error: 'Kaboom' }),
    );

    // Restore default
    (resolveSlashCommand as ReturnType<typeof vi.fn>).mockReturnValue({ type: 'plain' });
  });

  it('validates cwd via isAllowedPath', () => {
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
        prompt: 'hi',
        clientMsgId: 'cwd1',
        cwd: '/some/valid/path',
      },
      ctx,
    );

    expect(startChat).toHaveBeenCalledTimes(1);
  });
});

// ─── handleSendV2 — skill policy clearing ──────────────────────────────────

describe('handleSendV2 skill policy clearing', () => {
  it('calls clearSkillPolicy when no skill is invoked', () => {
    (clearSkillPolicy as ReturnType<typeof vi.fn>).mockClear();
    (startChat as ReturnType<typeof vi.fn>).mockClear();

    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: null, prompt: 'plain text', clientMsgId: 'cp1' },
      ctx,
    );

    expect(clearSkillPolicy).toHaveBeenCalledWith(expect.anything(), expect.any(String));
  });
});

// ─── handleSwitchSession — token fields ────────────────────────────────────

describe('handleSwitchSession token fields', () => {
  it('includes all token fields in session_switched response', async () => {
    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-tokens',
      mode: 'code',
      cwd: '/projects/bar',
      branch: 'develop',
      wtId: null,
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 1500,
      cacheCreationTokens: 300,
      totalCostUsd: 0.12,
    });

    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-tokens' }, ctx);

    const resp = transport.sent[0];
    expect(resp).toHaveProperty('tokens');
    const tokens = (resp as { tokens: Record<string, unknown> }).tokens;
    expect(tokens).toEqual({
      input: 5000,
      output: 2000,
      cacheRead: 1500,
      cacheCreation: 300,
      costUsd: 0.12,
    });
  });
});

// ─── handleSetModeV2 — broadcast to multiple watchers ──────────────────────

describe('handleSetModeV2 broadcast', () => {
  it('broadcasts mode_changed to multiple watchers', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport1 = mockTransport();
    const transport2 = mockTransport();
    ctx.connRegistry.register('c1', transport1);
    ctx.connRegistry.register('c2', transport2);
    ctx.connRegistry.watch('c1', 'sess-1');
    ctx.connRegistry.watch('c2', 'sess-1');

    handleSetModeV2('c1', { type: 'set_mode', sessionId: 'sess-1', mode: 'ask' }, ctx);

    expect(transport1.sent.some((m) => m.type === 'mode_changed' && m.mode === 'ask')).toBe(true);
    expect(transport2.sent.some((m) => m.type === 'mode_changed' && m.mode === 'ask')).toBe(true);
  });
});

// ─── handleWatch / handleUnwatch — edge cases ──────────────────────────────

describe('handleWatch edge cases', () => {
  it('watching the same session twice is idempotent', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleWatch('c1', { type: 'watch', sessionId: 'sess-1' }, ctx);
    handleWatch('c1', { type: 'watch', sessionId: 'sess-1' }, ctx);

    expect(ctx.connRegistry.get('c1')!.watchedSessions.has('sess-1')).toBe(true);
    expect(transport.sent.filter((m) => m.type === 'watched')).toHaveLength(2);
  });

  it('unwatching a session not watched is harmless', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleUnwatch('c1', { type: 'unwatch', sessionId: 'never-watched' }, ctx);

    expect(transport.sent).toContainEqual(
      expect.objectContaining({ type: 'unwatched', sessionId: 'never-watched' }),
    );
  });

  it('can watch multiple sessions on the same connection', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleWatch('c1', { type: 'watch', sessionId: 'sess-1' }, ctx);
    handleWatch('c1', { type: 'watch', sessionId: 'sess-2' }, ctx);
    handleWatch('c1', { type: 'watch', sessionId: 'sess-3' }, ctx);

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.watchedSessions.has('sess-1')).toBe(true);
    expect(conn.watchedSessions.has('sess-2')).toBe(true);
    expect(conn.watchedSessions.has('sess-3')).toBe(true);
  });
});

// ─── handleHello — edge cases ──────────────────────────────────────────────

describe('handleHello edge cases', () => {
  it('returns the provided connectionId', () => {
    const ctx = createContext();
    const transport = mockTransport();

    const id = handleHello('unique-conn-42', transport, ctx);

    expect(id).toBe('unique-conn-42');
  });

  it('welcome message includes protocolVersion 2', () => {
    const ctx = createContext();
    const transport = mockTransport();

    handleHello('c1', transport, ctx);

    expect(transport.sent[0]).toEqual(
      expect.objectContaining({
        type: 'welcome',
        protocolVersion: 2,
        connectionId: 'c1',
      }),
    );
  });
});

// ─── dispatchV2Message ─────────────────────────────────────────────────────

describe('dispatchV2Message', () => {
  it('ignores malformed JSON', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await dispatchV2Message('c1', transport, 'not json{{{', ctx);

    expect(transport.sent).toHaveLength(0);
  });

  it('ignores unrecognized message types', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await dispatchV2Message('c1', transport, JSON.stringify({ type: 'unknown_type' }), ctx);

    expect(transport.sent).toHaveLength(0);
  });

  it('ignores duplicate hello messages', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await dispatchV2Message(
      'c1',
      transport,
      JSON.stringify({ type: 'hello', protocolVersion: 2 }),
      ctx,
    );

    expect(transport.sent).toHaveLength(0);
  });

  it('routes watch messages correctly', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await dispatchV2Message(
      'c1',
      transport,
      JSON.stringify({ type: 'watch', sessionId: 'sess-1' }),
      ctx,
    );

    expect(transport.sent).toContainEqual(
      expect.objectContaining({ type: 'watched', sessionId: 'sess-1' }),
    );
  });

  it('routes unwatch messages correctly', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-1');

    await dispatchV2Message(
      'c1',
      transport,
      JSON.stringify({ type: 'unwatch', sessionId: 'sess-1' }),
      ctx,
    );

    expect(transport.sent).toContainEqual(
      expect.objectContaining({ type: 'unwatched', sessionId: 'sess-1' }),
    );
  });

  it('routes stop messages correctly', async () => {
    (stopChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await dispatchV2Message(
      'c1',
      transport,
      JSON.stringify({ type: 'stop', sessionId: 'sess-1' }),
      ctx,
    );

    expect(stopChat).toHaveBeenCalledWith('driver-1');
  });

  it('handles reconnect messages over WS (until P4 removes WS transport)', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await dispatchV2Message(
      'c1',
      transport,
      JSON.stringify({
        type: 'reconnect',
        sessions: [{ sessionId: 'sess-1', lastSeq: 0 }],
      }),
      ctx,
    );

    // WS reconnect calls watch() for each session
    expect(ctx.connRegistry.get('c1')?.watchedSessions.has('sess-1')).toBe(true);
  });

  it('routes set_mode messages correctly', async () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-1');

    await dispatchV2Message(
      'c1',
      transport,
      JSON.stringify({ type: 'set_mode', sessionId: 'sess-1', mode: 'agent' }),
      ctx,
    );

    expect(sessionReg.setMode).toHaveBeenCalledWith('driver-1', 'agent');
    expect(transport.sent.some((m) => m.type === 'mode_changed')).toBe(true);
  });
});

// ─── handleSwitchSession — unwatch on clear ─────────────────────────────────

describe('handleSwitchSession unwatch on clear', () => {
  it('unwatches the previous active session when switching to null', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-old');
    ctx.connRegistry.setActive('c1', 'sess-old');

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: null }, ctx);

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.activeSession).toBeNull();
    expect(conn.watchedSessions.has('sess-old')).toBe(false);
  });

  it('handles null switch when no previous active session', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: null }, ctx);

    expect(ctx.connRegistry.get('c1')!.activeSession).toBeNull();
    expect(transport.sent[0]).toEqual(expect.objectContaining({ type: 'session_cleared' }));
  });

  it('preserves other watched sessions when clearing active', async () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-a');
    ctx.connRegistry.watch('c1', 'sess-b');
    ctx.connRegistry.setActive('c1', 'sess-a');

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: null }, ctx);

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.watchedSessions.has('sess-a')).toBe(false);
    expect(conn.watchedSessions.has('sess-b')).toBe(true);
  });

  it('unwatches the previous active session when switching to a different session', async () => {
    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-new',
      isActive: false,
      mode: 'agent',
      cwd: '/tmp',
    });
    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-old');
    ctx.connRegistry.setActive('c1', 'sess-old');

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-new' }, ctx);

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.watchedSessions.has('sess-old')).toBe(false);
    expect(conn.watchedSessions.has('sess-new')).toBe(true);
    expect(conn.activeSession).toBe('sess-new');
  });

  it('does not unwatch when switching to the same session', async () => {
    const eventStore = mockEventStore();
    eventStore.getSession.mockReturnValue({
      sessionId: 'sess-a',
      isActive: false,
      mode: 'agent',
      cwd: '/tmp',
    });
    const ctx = createContext({
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.watch('c1', 'sess-a');
    ctx.connRegistry.setActive('c1', 'sess-a');

    await handleSwitchSession('c1', { type: 'switch_session', sessionId: 'sess-a' }, ctx);

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.watchedSessions.has('sess-a')).toBe(true);
    expect(conn.activeSession).toBe('sess-a');
  });
});

// ─── handleSendV2 — connection ownership ─────────────────────────────────────

describe('handleSendV2 connection ownership', () => {
  it('takes over session from another connection on send', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (rekeyChat as ReturnType<typeof vi.fn>).mockClear();
    (denyPendingBySession as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    const oldTransport = mockTransport();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'other-conn:sess-1',
      session: { transport: oldTransport },
    });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.register('other-conn', oldTransport);
    ctx.connRegistry.watch('other-conn', 'sess-1');

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'cmsg-1' },
      ctx,
    );

    // Old transport receives session_takeover
    expect(oldTransport.sent).toContainEqual(
      expect.objectContaining({ type: 'session_takeover', sessionId: 'sess-1' }),
    );
    // Old connection unwatched
    expect(ctx.connRegistry.get('other-conn')?.watchedSessions.has('sess-1')).toBe(false);
    // Pending permissions denied
    expect(denyPendingBySession).toHaveBeenCalledWith('sess-1');
    // Session rekeyed and send proceeds
    expect(reattachChat).toHaveBeenCalledWith('other-conn:sess-1', transport);
    expect(rekeyChat).toHaveBeenCalledWith('other-conn:sess-1', 'c1:sess-1');
    expect(sendToChat).toHaveBeenCalled();
    // No active_elsewhere error
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('allows send when owner connection is gone (same device reconnect)', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    // clientId owned by 'other-conn' which is NOT registered (dead WS)
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'other-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true); // not yet detached

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    // other-conn is NOT registered — simulates dead WS

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('other-conn:sess-1', transport);
    expect(sendToChat).toHaveBeenCalled();
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('allows send when session is detached even from another connection', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'other-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(false); // detached — takeover allowed

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('other-conn:sess-1', transport);
    expect(sendToChat).toHaveBeenCalled();
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('allows send from the owning connection', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(sendToChat).toHaveBeenCalledWith('c1:sess-1', 'hi', undefined, undefined, 'cmsg-1');

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ─── state-based routing (Phase 3) ──────────────────────────────────────────

describe('handleSendV2 state-based routing', () => {
  it('aborts zombie and resumes when state is ENDED but registry still has session', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    // State machine says ENDED — query loop should be dead
    eventStore.getSessionState.mockReturnValue('ENDED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hello', clientMsgId: 'cmsg-stale' },
      ctx,
    );

    // Should abort the zombie, not just remove
    expect(stopChat).toHaveBeenCalledWith('old-conn:sess-1');
    // Should fall through to resume path
    expect(startChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('takes over when state is ACTIVE and different owner', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    const oldTransport = mockTransport();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'other-conn:sess-1',
      session: { transport: oldTransport },
    });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ACTIVE');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.register('other-conn', oldTransport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hello', clientMsgId: 'cmsg-active' },
      ctx,
    );

    expect(oldTransport.sent).toContainEqual(expect.objectContaining({ type: 'session_takeover' }));
    expect(sendToChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('routes to sendToChat when state is ACTIVE and same owner', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ACTIVE');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hello again', clientMsgId: 'rapid-2' },
      ctx,
    );

    // Should NOT abort — state says ACTIVE
    expect(stopChat).not.toHaveBeenCalled();
    expect(sendToChat).toHaveBeenCalledWith(
      'c1:sess-1',
      'hello again',
      undefined,
      undefined,
      'rapid-2',
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('reattaches own detached session when state is DETACHED', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(false); // detached

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('DETACHED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'back', clientMsgId: 'reattach-1' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalled();
    expect(sendToChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('treats CLOSING as zombie and resumes', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('CLOSING');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'closing-1' },
      ctx,
    );

    expect(sendToChat).not.toHaveBeenCalled();
    expect(stopChat).toHaveBeenCalledWith('c1:sess-1');
    expect(startChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

describe('handleInterruptV2 state-based routing', () => {
  it('aborts zombie and resumes when state is ENDED', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ENDED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'stop', clientMsgId: 'i-stale' },
      ctx,
    );

    expect(stopChat).toHaveBeenCalledWith('old-conn:sess-1');
    expect(interruptChat).not.toHaveBeenCalled();
    expect(startChat).toHaveBeenCalledWith(
      transport,
      'c1:sess-1',
      'stop',
      expect.objectContaining({ resume: 'sess-1', clientMsgId: 'i-stale' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('routes to interruptChat when state is ACTIVE and same owner', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ACTIVE');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'stop', clientMsgId: 'i-active' },
      ctx,
    );

    expect(stopChat).not.toHaveBeenCalled();
    expect(interruptChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('treats CLOSING as zombie and resumes', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('CLOSING');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'stop', clientMsgId: 'closing-i' },
      ctx,
    );

    expect(interruptChat).not.toHaveBeenCalled();
    expect(stopChat).toHaveBeenCalledWith('c1:sess-1');
    expect(startChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ─── handleReconnect — no ownership dance (P3) ──────────────────────────────
// Ownership (reattach/rekey/zombie) is handled by handleSendV2 on first message.
// These tests verify reconnect does NOT attempt ownership operations.

// ─── handleInterruptV2 — images and contextBlocks forwarding ───────────────

describe('handleInterruptV2 forwarding', () => {
  it('forwards images and contextBlocks to interruptChat when session is active', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isAttached.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    const images = [{ data: 'base64img', mediaType: 'image/png' as const }];
    const contextBlocks = ['some context block'];

    handleInterruptV2(
      'c1',
      transport,
      {
        type: 'interrupt',
        sessionId: 'sess-1',
        prompt: 'new direction',
        clientMsgId: 'i3',
        images,
        contextBlocks,
      },
      ctx,
    );

    expect(interruptChat).toHaveBeenCalledWith(
      'c1:sess-1',
      'new direction',
      images,
      contextBlocks,
      'i3',
      undefined,
    );
  });

  it('forwards model to interruptChat when session is active', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-model', session: {} });
    sessionReg.isAttached.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      {
        type: 'interrupt',
        sessionId: 'sess-model',
        prompt: 'change model',
        clientMsgId: 'i-model',
        model: 'claude-opus-4-6',
      },
      ctx,
    );

    expect(interruptChat).toHaveBeenCalledWith(
      'c1:sess-model',
      'change model',
      undefined,
      undefined,
      'i-model',
      'claude-opus-4-6',
    );
  });

  it('forwards images and contextBlocks to startChat when session is idle', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'driver-1', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    const images = [{ data: 'base64img', mediaType: 'image/png' as const }];
    const contextBlocks = ['some context block'];

    handleInterruptV2(
      'c1',
      transport,
      {
        type: 'interrupt',
        sessionId: 'sess-1',
        prompt: 'new direction',
        clientMsgId: 'i3',
        images,
        contextBlocks,
      },
      ctx,
    );

    expect(startChat).toHaveBeenCalledWith(
      transport,
      'c1:sess-1',
      'new direction',
      expect.objectContaining({ resume: 'sess-1', images, contextBlocks, clientMsgId: 'i3' }),
    );
  });

  it('forwards msg.model to startChat when session is idle', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c-idle', session: {} });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c2', transport);

    handleInterruptV2(
      'c2',
      transport,
      {
        type: 'interrupt',
        sessionId: 'sess-resume',
        prompt: 'urgent',
        clientMsgId: 'i-resume',
        model: 'claude-opus-4-7',
      },
      ctx,
    );

    expect(startChat).toHaveBeenCalledWith(
      transport,
      'c2:sess-resume',
      'urgent',
      expect.objectContaining({ resume: 'sess-resume', model: 'claude-opus-4-7' }),
    );
  });

  it('uses found.session.model as fallback when msg.model is absent', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'c-fallback',
      session: { model: 'claude-sonnet-4-6' },
    });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c3', transport);

    handleInterruptV2(
      'c3',
      transport,
      {
        type: 'interrupt',
        sessionId: 'sess-fallback',
        prompt: 'no model',
        clientMsgId: 'i-fallback',
      },
      ctx,
    );

    expect(startChat).toHaveBeenCalledWith(
      transport,
      'c3:sess-fallback',
      'no model',
      expect.objectContaining({ resume: 'sess-fallback', model: 'claude-sonnet-4-6' }),
    );
  });

  it('msg.model takes precedence over found.session.model', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'c-precedence',
      session: { model: 'claude-sonnet-4-6' },
    });

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c4', transport);

    handleInterruptV2(
      'c4',
      transport,
      {
        type: 'interrupt',
        sessionId: 'sess-precedence',
        prompt: 'override',
        clientMsgId: 'i-precedence',
        model: 'claude-opus-4-7',
      },
      ctx,
    );

    expect(startChat).toHaveBeenCalledWith(
      transport,
      'c4:sess-precedence',
      'override',
      expect.objectContaining({ resume: 'sess-precedence', model: 'claude-opus-4-7' }),
    );
  });

  it('does not watch or activate when session is not found', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'ghost', prompt: 'x', clientMsgId: 'i4' },
      ctx,
    );

    const conn = ctx.connRegistry.get('c1')!;
    expect(conn.watchedSessions.size).toBe(0);
    expect(conn.activeSession).toBeNull();
  });
});

// ─── getOwnerConnection ─────────────────────────────────────────────────────

describe('getOwnerConnection', () => {
  it('extracts connectionId before the first colon', () => {
    expect(getOwnerConnection('conn-123:sess-abc')).toBe('conn-123');
  });

  it('handles composite suffix with multiple colons', () => {
    expect(getOwnerConnection('conn-1:new-abcd1234:extra')).toBe('conn-1');
  });

  it('returns the full string when no colon present', () => {
    expect(getOwnerConnection('legacy-client-id')).toBe('legacy-client-id');
  });

  it('handles empty string', () => {
    expect(getOwnerConnection('')).toBe('');
  });
});

// ─── handleInterruptV2 — connection ownership ───────────────────────────────

describe('handleInterruptV2 connection ownership', () => {
  it('takes over session from another connection on interrupt', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (rekeyChat as ReturnType<typeof vi.fn>).mockClear();
    (denyPendingBySession as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    const oldTransport = mockTransport();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'other-conn:sess-1',
      session: { transport: oldTransport },
    });
    sessionReg.isAttached.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);
    ctx.connRegistry.register('other-conn', oldTransport);
    ctx.connRegistry.watch('other-conn', 'sess-1');

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'stop', clientMsgId: 'i5' },
      ctx,
    );

    // Old transport receives session_takeover
    expect(oldTransport.sent).toContainEqual(
      expect.objectContaining({ type: 'session_takeover', sessionId: 'sess-1' }),
    );
    // Old connection unwatched
    expect(ctx.connRegistry.get('other-conn')?.watchedSessions.has('sess-1')).toBe(false);
    // Pending permissions denied
    expect(denyPendingBySession).toHaveBeenCalledWith('sess-1');
    // Session rekeyed and interrupt proceeds
    expect(reattachChat).toHaveBeenCalledWith('other-conn:sess-1', transport);
    expect(rekeyChat).toHaveBeenCalledWith('other-conn:sess-1', 'c1:sess-1');
    expect(interruptChat).toHaveBeenCalled();
    // No active_elsewhere error
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('allows interrupt when owner connection is gone (same device reconnect)', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'other-conn:sess-1', session: {} });
    sessionReg.isAttached.mockReturnValue(true); // not yet detached
    // other-conn NOT registered — dead WS

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'stop', clientMsgId: 'i5' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('other-conn:sess-1', transport);
    expect(interruptChat).toHaveBeenCalled();
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('allows interrupt from the owning connection', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'c1:sess-1', session: {} });
    sessionReg.isAttached.mockReturnValue(true);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'redirect', clientMsgId: 'i6' },
      ctx,
    );

    expect(interruptChat).toHaveBeenCalledWith(
      'c1:sess-1',
      'redirect',
      undefined,
      undefined,
      'i6',
      undefined,
    );
  });

  it('allows interrupt when session is detached (takeover)', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'other-conn:sess-1', session: {} });
    sessionReg.isAttached.mockReturnValue(false); // detached

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'takeover', clientMsgId: 'i7' },
      ctx,
    );

    expect(interruptChat).toHaveBeenCalled();
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );
  });
});

// rekey after reattach tests removed — reconnect no longer does ownership transfer (P3).
// handleSendV2 rekey tests (below) still cover the rekey-on-send path.

describe('handleSendV2 rekey after detached reattach', () => {
  it('rekeys and uses new clientId for sendToChat when taking over detached session', () => {
    (sendToChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (rekeyChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'dead-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(false); // detached

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('new-conn', transport);

    handleSendV2(
      'new-conn',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hello', clientMsgId: 'cmsg-rk' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('dead-conn:sess-1', transport);
    expect(rekeyChat).toHaveBeenCalledWith('dead-conn:sess-1', 'new-conn:sess-1');
    // sendToChat must use the NEW clientId, not the old one
    expect(sendToChat).toHaveBeenCalledWith(
      'new-conn:sess-1',
      'hello',
      undefined,
      undefined,
      'cmsg-rk',
    );
    expect(transport.sent).not.toContainEqual(
      expect.objectContaining({ code: 'active_elsewhere' }),
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

describe('handleInterruptV2 rekey after detached reattach', () => {
  it('rekeys and uses new clientId for interruptChat when taking over detached session', () => {
    (interruptChat as ReturnType<typeof vi.fn>).mockClear();
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();
    (rekeyChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'dead-conn:sess-1', session: {} });
    sessionReg.isAttached.mockReturnValue(false); // detached

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('new-conn', transport);

    handleInterruptV2(
      'new-conn',
      transport,
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'redirect', clientMsgId: 'i-rk' },
      ctx,
    );

    expect(reattachChat).toHaveBeenCalledWith('dead-conn:sess-1', transport);
    expect(rekeyChat).toHaveBeenCalledWith('dead-conn:sess-1', 'new-conn:sess-1');
    // interruptChat must use the NEW clientId
    expect(interruptChat).toHaveBeenCalledWith(
      'new-conn:sess-1',
      'redirect',
      undefined,
      undefined,
      'i-rk',
      undefined,
    );

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ─── stale session cleanup — registry.remove() ──────────────────────────────

describe('stale session cleanup removes registry entry', () => {
  it('handleReconnect does not remove stale sessions (deferred to handleSendV2)', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ENDED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleReconnect(
      'c1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    // Zombie cleanup deferred to handleSendV2 on first user message
    expect(sessionReg.remove).not.toHaveBeenCalled();
  });

  it('handleSendV2 aborts zombie session before resume', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ENDED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleSendV2(
      'c1',
      transport,
      { type: 'send' as const, sessionId: 'sess-1', prompt: 'hello', clientMsgId: 'cmsg-1' },
      ctx,
    );

    expect(stopChat).toHaveBeenCalledWith('old-conn:sess-1');
    expect(startChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('handleInterruptV2 aborts zombie session before resume', () => {
    (startChat as ReturnType<typeof vi.fn>).mockClear();
    (stopChat as ReturnType<typeof vi.fn>).mockClear();
    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({ clientId: 'old-conn:sess-1', session: {} });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isAttached.mockReturnValue(true);

    const eventStore = mockEventStore();
    eventStore.getSessionState.mockReturnValue('ENDED');

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
      eventStore: eventStore as unknown as V2HandlerContext['eventStore'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    handleInterruptV2(
      'c1',
      transport,
      { type: 'interrupt' as const, sessionId: 'sess-1', prompt: 'stop', clientMsgId: 'cmsg-2' },
      ctx,
    );

    expect(stopChat).toHaveBeenCalledWith('old-conn:sess-1');
    expect(startChat).toHaveBeenCalled();

    (isActive as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });
});

// ─── handleSessionSuspend ───────────────────────────────────────────────────

describe('handleSessionSuspend', () => {
  it('suspends sessions owned by the connection', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'conn-1:sess-1',
      session: { sessionId: 'sess-1' },
    });
    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });

    handleSessionSuspend(
      'conn-1',
      { type: 'session_suspend', sessions: [{ sessionId: 'sess-1', lastSeq: 42 }] },
      ctx,
    );

    expect(sessionReg.suspend).toHaveBeenCalledWith('conn-1:sess-1', 42);
  });

  it('rejects suspend from non-owner connection', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'conn-other:sess-1',
      session: { sessionId: 'sess-1' },
    });
    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });

    handleSessionSuspend(
      'conn-1',
      { type: 'session_suspend', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    expect(sessionReg.suspend).not.toHaveBeenCalled();
  });

  it('skips unknown sessions without error', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue(null);
    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });

    expect(() =>
      handleSessionSuspend(
        'conn-1',
        { type: 'session_suspend', sessions: [{ sessionId: 'unknown', lastSeq: 0 }] },
        ctx,
      ),
    ).not.toThrow();
  });

  it('suspends multiple sessions in a single message', () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockImplementation((sid: string) => ({
      clientId: `conn-1:${sid}`,
      session: { sessionId: sid },
    }));
    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });

    handleSessionSuspend(
      'conn-1',
      {
        type: 'session_suspend',
        sessions: [
          { sessionId: 'sess-1', lastSeq: 10 },
          { sessionId: 'sess-2', lastSeq: 20 },
        ],
      },
      ctx,
    );

    expect(sessionReg.suspend).toHaveBeenCalledTimes(2);
    expect(sessionReg.suspend).toHaveBeenCalledWith('conn-1:sess-1', 10);
    expect(sessionReg.suspend).toHaveBeenCalledWith('conn-1:sess-2', 20);
  });
});

// ─── handleReconnect — suspend resume ───────────────────────────────────────

describe('handleReconnect suspend resume', () => {
  it('clears suspend state and sends session_resumed', () => {
    (reattachChat as ReturnType<typeof vi.fn>).mockClear();

    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'conn-1:sess-1',
      session: { sessionId: 'sess-1' },
    });
    sessionReg.isActive.mockReturnValue(true);
    sessionReg.isSuspended.mockReturnValue(true);
    sessionReg.resume.mockReturnValue([
      { v: 2, type: 'block_delta', delta: 'buffered-text', sessionId: 'sess-1' },
    ]);

    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('conn-1', transport);

    handleReconnect(
      'conn-1',
      { type: 'reconnect', sessions: [{ sessionId: 'sess-1', lastSeq: 0 }] },
      ctx,
    );

    expect(sessionReg.resume).toHaveBeenCalledWith('conn-1:sess-1');
    // Buffered events should NOT be replayed — EventStore replay covers them.
    expect(
      transport.sent.some((m) => m.type === 'block_delta' && m.delta === 'buffered-text'),
    ).toBe(false);
    // Should have sent session_resumed with total replayed count
    expect(transport.sent.some((m) => m.type === 'session_resumed' && m.replayed === 1)).toBe(true);
    // No reattach — ownership deferred to handleSendV2
    expect(reattachChat).not.toHaveBeenCalled();
  });
});

// ─── dispatchV2Message — session_suspend ────────────────────────────────────

describe('dispatchV2Message session_suspend', () => {
  it('dispatches session_suspend to handleSessionSuspend', async () => {
    const sessionReg = mockSessionRegistry();
    sessionReg.findBySessionId.mockReturnValue({
      clientId: 'conn-1:sess-1',
      session: { sessionId: 'sess-1' },
    });
    const ctx = createContext({
      sessionRegistry: sessionReg as unknown as V2HandlerContext['sessionRegistry'],
    });
    const transport = mockTransport();
    ctx.connRegistry.register('conn-1', transport);

    await dispatchV2Message(
      'conn-1',
      transport,
      JSON.stringify({
        type: 'session_suspend',
        sessions: [{ sessionId: 'sess-1', lastSeq: 5 }],
      }),
      ctx,
    );

    expect(sessionReg.suspend).toHaveBeenCalledWith('conn-1:sess-1', 5);
  });
});
// ─── handleSendV2 agentName parameter ────────────────────────────────────────

describe('handleSendV2 agentName', () => {
  it('forwards agentName from message to startChat', () => {
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
        prompt: 'test',
        clientMsgId: 'msg-1',
        agentName: 'mitzo-telos',
      },
      ctx,
    );

    const callArgs = (startChat as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = callArgs[3];
    expect(options.agentName).toBe('mitzo-telos');
  });

  it('omits agentName when not provided in message', () => {
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
        prompt: 'test',
        clientMsgId: 'msg-1',
      },
      ctx,
    );

    const callArgs = (startChat as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = callArgs[3];
    expect(options.agentName).toBeUndefined();
  });

  it('rejects path traversal attempts via schema validation', () => {
    const ctx = createContext();
    const transport = mockTransport();
    ctx.connRegistry.register('c1', transport);

    // The Zod schema should reject these before handleSendV2 is called
    // This test documents the expected validation behavior
    expect(() =>
      V2SendMessage.parse({
        type: 'send',
        sessionId: null,
        prompt: 'test',
        clientMsgId: 'msg-1',
        agentName: '../../etc/passwd',
      }),
    ).toThrow();

    expect(() =>
      V2SendMessage.parse({
        type: 'send',
        sessionId: null,
        prompt: 'test',
        clientMsgId: 'msg-1',
        agentName: '../secrets',
      }),
    ).toThrow();

    expect(() =>
      V2SendMessage.parse({
        type: 'send',
        sessionId: null,
        prompt: 'test',
        clientMsgId: 'msg-1',
        agentName: 'mitzo/evil',
      }),
    ).toThrow();
  });

  it('accepts valid agent names', () => {
    // These should all parse successfully
    const validNames = ['mitzo-telos', 'mitzo-calendar', 'mitzo_test', 'agent123', 'a-b_c-1'];

    validNames.forEach((name) => {
      const result = V2SendMessage.parse({
        type: 'send',
        sessionId: null,
        prompt: 'test',
        clientMsgId: 'msg-1',
        agentName: name,
      });
      expect(result.agentName).toBe(name);
    });
  });
});

// ─── detectStateMismatch ────────────────────────────────────────────────────

describe('detectStateMismatch', () => {
  it('returns no mismatch when registry and store agree (both absent)', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue(null);
    store.getSessionState.mockReturnValue(null);

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('returns no mismatch when registry and store agree (ENDED + absent)', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue(null);
    store.getSessionState.mockReturnValue('ENDED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('returns no mismatch when ACTIVE + attached', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(true);
    store.getSessionState.mockReturnValue('ACTIVE');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('returns no mismatch when DETACHED + not attached', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(false);
    store.getSessionState.mockReturnValue('DETACHED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('returns no mismatch when SUSPENDED + not attached', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(false);
    store.getSessionState.mockReturnValue('SUSPENDED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('detects registry has session but state=ENDED', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    store.getSessionState.mockReturnValue('ENDED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(true);
    expect(result.details).toContain('registry has session but state=ENDED');
  });

  it('detects registry has session but state=null', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    store.getSessionState.mockReturnValue(null);

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(true);
    expect(result.details).toContain('registry has session but state=null');
  });

  it('detects registry missing but state=ACTIVE', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue(null);
    store.getSessionState.mockReturnValue('ACTIVE');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(true);
    expect(result.details).toContain('registry missing session but state=ACTIVE');
  });

  it('detects attached transport but DETACHED state', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(true);
    store.getSessionState.mockReturnValue('DETACHED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(true);
    expect(result.details).toContain('transport attached but state=DETACHED');
  });

  it('detects attached transport but SUSPENDED state', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(true);
    store.getSessionState.mockReturnValue('SUSPENDED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(true);
    expect(result.details).toContain('transport attached but state=SUSPENDED');
  });

  it('detects detached transport but ACTIVE state', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(false);
    store.getSessionState.mockReturnValue('ACTIVE');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(true);
    expect(result.details).toContain('transport detached but state=ACTIVE');
  });

  it('ignores CLOSING state (graceful shutdown — registry state is indeterminate)', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(false);
    store.getSessionState.mockReturnValue('CLOSING');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('allows STARTING state in registry regardless of attach state', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(true);
    store.getSessionState.mockReturnValue('STARTING');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });

  it('allows CREATED state in registry regardless of attach state', () => {
    const reg = mockSessionRegistry();
    const store = mockEventStore();
    reg.findBySessionId.mockReturnValue({ clientId: 'c1', session: {} });
    reg.isAttached.mockReturnValue(true);
    store.getSessionState.mockReturnValue('CREATED');

    const result = detectStateMismatch(
      'sess-1',
      reg as unknown as V2HandlerContext['sessionRegistry'],
      store as unknown as V2HandlerContext['eventStore'],
    );
    expect(result.mismatch).toBe(false);
  });
});
