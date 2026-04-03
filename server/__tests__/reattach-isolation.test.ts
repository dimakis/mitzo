import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../session-registry.js';

describe('SessionRegistry.rekey', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('moves a session from oldId to newId', () => {
    const ws = { readyState: 1, OPEN: 1 } as any;
    const abort = new AbortController();
    registry.register('old-client', {
      ws,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sdk-123',
    });

    const ok = registry.rekey('old-client', 'new-client');

    expect(ok).toBe(true);
    expect(registry.get('old-client')).toBeUndefined();
    expect(registry.isActive('old-client')).toBe(false);
    expect(registry.get('new-client')).toBeDefined();
    expect(registry.isActive('new-client')).toBe(true);
    expect(registry.get('new-client')!.ws).toBe(ws);
    expect(registry.get('new-client')!.sessionId).toBe('sdk-123');
  });

  it('preserves attached status under the new key', () => {
    const ws = { readyState: 1, OPEN: 1 } as any;
    registry.register('old-client', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    registry.rekey('old-client', 'new-client');

    expect(registry.isAttached('old-client')).toBe(false);
    expect(registry.isAttached('new-client')).toBe(true);
  });

  it('returns false if oldId does not exist', () => {
    const ok = registry.rekey('nonexistent', 'new-client');
    expect(ok).toBe(false);
  });

  it('abort works on the new key after rekey', () => {
    const ws = { readyState: 1, OPEN: 1 } as any;
    const abort = new AbortController();
    registry.register('old-client', {
      ws,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    registry.rekey('old-client', 'new-client');
    registry.abort('new-client');

    expect(abort.signal.aborted).toBe(true);
    expect(registry.isActive('new-client')).toBe(false);
  });

  it('findBySessionId returns the new clientId after rekey', () => {
    const ws = { readyState: 1, OPEN: 1 } as any;
    registry.register('old-client', {
      ws,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      sessionId: 'sdk-456',
    });

    registry.rekey('old-client', 'new-client');

    const found = registry.findBySessionId('sdk-456');
    expect(found).not.toBeNull();
    expect(found!.clientId).toBe('new-client');
  });

  it('transfers detach timer from old key to new key', () => {
    const ws1 = { readyState: 1, OPEN: 1 } as any;
    const ws2 = { readyState: 1, OPEN: 1 } as any;
    const abort = new AbortController();
    registry.register('old-client', {
      ws: ws1,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    registry.detach('old-client');
    registry.reattach('old-client', ws2);
    registry.rekey('old-client', 'new-client');

    // Session should be alive and operable under new key
    expect(registry.isActive('new-client')).toBe(true);
    expect(registry.get('new-client')!.ws).toBe(ws2);
  });

  it('drainDetachedBuffer returns messages buffered during detach', () => {
    const ws1 = { readyState: 1, OPEN: 1 } as any;
    const ws2 = { readyState: 1, OPEN: 1 } as any;

    registry.register('old-client', {
      ws: ws1,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    // Detach and buffer messages
    registry.detach('old-client');
    registry.bufferDetached('old-client', { type: 'block_start', blockId: 'b0' });
    registry.bufferDetached('old-client', { type: 'block_delta', delta: 'hello' });
    registry.bufferDetached('old-client', { type: 'block_end', blockId: 'b0' });
    registry.bufferDetached('old-client', { type: 'message_end', messageId: 'msg-1' });

    // Reattach
    registry.reattach('old-client', ws2);

    // Drain should return all buffered messages in order
    const drained = registry.drainDetachedBuffer('old-client');
    expect(drained).toHaveLength(4);
    expect((drained[0] as any).type).toBe('block_start');
    expect((drained[1] as any).type).toBe('block_delta');
    expect((drained[2] as any).type).toBe('block_end');
    expect((drained[3] as any).type).toBe('message_end');

    // Second drain should be empty
    expect(registry.drainDetachedBuffer('old-client')).toHaveLength(0);
  });

  it('rekey + reattach full cycle prevents isActive split brain', () => {
    const ws1 = { readyState: 1, OPEN: 1 } as any;
    const ws2 = { readyState: 1, OPEN: 1 } as any;
    const abort = new AbortController();

    // Simulate: session starts on old WS
    registry.register('old-client', {
      ws: ws1,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    // WS drops, session detaches
    registry.detach('old-client');

    // New WS connects, reattaches, then rekeys
    registry.reattach('old-client', ws2);
    registry.rekey('old-client', 'new-client');

    // The new clientId is the only active one
    expect(registry.isActive('new-client')).toBe(true);
    expect(registry.isActive('old-client')).toBe(false);

    // stop/abort via new clientId works
    registry.abort('new-client');
    expect(abort.signal.aborted).toBe(true);
    expect(registry.isActive('new-client')).toBe(false);
  });
});
