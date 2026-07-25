import { describe, it, expect } from 'vitest';
import {
  HelloMessage,
  ReconnectMessage,
  WatchMessage,
  UnwatchMessage,
  SwitchSessionMessage,
  V2SendMessage,
  V2InterruptMessage,
  V2StopMessage,
  V2PermissionResponseMessage,
  V2SetModeMessage,
  IncomingWsMessageV2,
} from '../src/ws-schemas-v2.js';

describe('v2 hello handshake', () => {
  it('accepts hello with protocolVersion 2', () => {
    const r = HelloMessage.safeParse({ type: 'hello', protocolVersion: 2 });
    expect(r.success).toBe(true);
  });

  it('rejects hello without protocolVersion', () => {
    const r = HelloMessage.safeParse({ type: 'hello' });
    expect(r.success).toBe(false);
  });
});

describe('v2 reconnect', () => {
  it('accepts reconnect with sessions array', () => {
    const r = ReconnectMessage.safeParse({
      type: 'reconnect',
      sessions: [
        { sessionId: 'sess-1', lastSeq: 42 },
        { sessionId: 'sess-2', lastSeq: 0 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts reconnect with empty sessions array', () => {
    const r = ReconnectMessage.safeParse({ type: 'reconnect', sessions: [] });
    expect(r.success).toBe(true);
  });

  it('rejects reconnect without sessions', () => {
    const r = ReconnectMessage.safeParse({ type: 'reconnect' });
    expect(r.success).toBe(false);
  });
});

describe('v2 watch / unwatch', () => {
  it('accepts watch with sessionId', () => {
    const r = WatchMessage.safeParse({ type: 'watch', sessionId: 'sess-1' });
    expect(r.success).toBe(true);
  });

  it('rejects watch with empty sessionId', () => {
    const r = WatchMessage.safeParse({ type: 'watch', sessionId: '' });
    expect(r.success).toBe(false);
  });

  it('accepts unwatch with sessionId', () => {
    const r = UnwatchMessage.safeParse({ type: 'unwatch', sessionId: 'sess-1' });
    expect(r.success).toBe(true);
  });
});

describe('v2 switch_session', () => {
  it('accepts switch_session with sessionId', () => {
    const r = SwitchSessionMessage.safeParse({ type: 'switch_session', sessionId: 'sess-1' });
    expect(r.success).toBe(true);
  });

  it('accepts switch_session with null sessionId (new chat)', () => {
    const r = SwitchSessionMessage.safeParse({ type: 'switch_session', sessionId: null });
    expect(r.success).toBe(true);
  });
});

describe('v2 send', () => {
  it('accepts send with explicit sessionId', () => {
    const r = V2SendMessage.safeParse({
      type: 'send',
      sessionId: 'sess-1',
      prompt: 'hello',
      clientMsgId: 'u-1',
    });
    expect(r.success).toBe(true);
  });

  it('accepts send with null sessionId (new session)', () => {
    const r = V2SendMessage.safeParse({
      type: 'send',
      sessionId: null,
      prompt: 'hello',
      clientMsgId: 'u-1',
    });
    expect(r.success).toBe(true);
  });

  it('rejects send without sessionId field', () => {
    const r = V2SendMessage.safeParse({
      type: 'send',
      prompt: 'hello',
      clientMsgId: 'u-1',
    });
    expect(r.success).toBe(false);
  });

  it('accepts send with telosTaskId', () => {
    const r = V2SendMessage.safeParse({
      type: 'send',
      sessionId: null,
      prompt: 'hello',
      clientMsgId: 'u-1',
      telosTaskId: 'abc123def456',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.telosTaskId).toBe('abc123def456');
    }
  });
});

describe('v2 interrupt / stop / permission_response / set_mode', () => {
  it('accepts interrupt with sessionId', () => {
    const r = V2InterruptMessage.safeParse({
      type: 'interrupt',
      sessionId: 'sess-1',
      prompt: 'wait',
      clientMsgId: 'u-2',
    });
    expect(r.success).toBe(true);
  });

  it('accepts stop with sessionId', () => {
    const r = V2StopMessage.safeParse({ type: 'stop', sessionId: 'sess-1' });
    expect(r.success).toBe(true);
  });

  it('accepts permission_response with sessionId', () => {
    const r = V2PermissionResponseMessage.safeParse({
      type: 'permission_response',
      sessionId: 'sess-1',
      permId: 'p1',
      decision: 'once',
    });
    expect(r.success).toBe(true);
  });

  it('accepts set_mode with sessionId', () => {
    const r = V2SetModeMessage.safeParse({
      type: 'set_mode',
      sessionId: 'sess-1',
      mode: 'auto',
    });
    expect(r.success).toBe(true);
  });
});

describe('IncomingWsMessageV2 discriminated union', () => {
  it('parses all v2 message types', () => {
    const messages = [
      { type: 'hello', protocolVersion: 2 },
      { type: 'reconnect', sessions: [] },
      { type: 'watch', sessionId: 'sess-1' },
      { type: 'unwatch', sessionId: 'sess-1' },
      { type: 'switch_session', sessionId: 'sess-1' },
      { type: 'send', sessionId: 'sess-1', prompt: 'hi', clientMsgId: 'u-1' },
      { type: 'interrupt', sessionId: 'sess-1', prompt: 'w', clientMsgId: 'u-2' },
      { type: 'stop', sessionId: 'sess-1' },
      { type: 'permission_response', sessionId: 'sess-1', permId: 'p1' },
      { type: 'set_mode', sessionId: 'sess-1', mode: 'agent' },
    ];
    for (const msg of messages) {
      const r = IncomingWsMessageV2.safeParse(msg);
      expect(r.success, `Failed for type=${msg.type}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it('rejects v1-only messages (reattach, subscribe)', () => {
    expect(IncomingWsMessageV2.safeParse({ type: 'reattach', clientId: 'c1' }).success).toBe(false);
    expect(IncomingWsMessageV2.safeParse({ type: 'subscribe', sessionId: 's1' }).success).toBe(
      false,
    );
  });
});
