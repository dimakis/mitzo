import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import type { SessionTransport } from '@mitzo/harness';

function mockTransport(open = true): SessionTransport {
  return {
    send: () => {},
    isOpen: () => open,
  };
}

describe('SessionRegistry.rekey', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  it('moves a session from oldId to newId', () => {
    const transport = mockTransport();
    const abort = new AbortController();
    registry.register('old-client', {
      transport,
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
    expect(registry.get('new-client')!.transport).toBe(transport);
    expect(registry.get('new-client')!.sessionId).toBe('sdk-123');
  });

  it('preserves attached status under the new key', () => {
    const transport = mockTransport();
    registry.register('old-client', {
      transport,
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
    const transport = mockTransport();
    const abort = new AbortController();
    registry.register('old-client', {
      transport,
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
    const transport = mockTransport();
    registry.register('old-client', {
      transport,
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
    const transport1 = mockTransport();
    const transport2 = mockTransport();
    const abort = new AbortController();
    registry.register('old-client', {
      transport: transport1,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    registry.detach('old-client');
    registry.reattach('old-client', transport2);
    registry.rekey('old-client', 'new-client');

    // Session should be alive and operable under new key
    expect(registry.isActive('new-client')).toBe(true);
    expect(registry.get('new-client')!.transport).toBe(transport2);
  });

  it('rekey + reattach full cycle prevents isActive split brain', () => {
    const transport1 = mockTransport();
    const transport2 = mockTransport();
    const abort = new AbortController();

    // Simulate: session starts on old transport
    registry.register('old-client', {
      transport: transport1,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    // Transport drops, session detaches
    registry.detach('old-client');

    // New transport connects, reattaches, then rekeys
    registry.reattach('old-client', transport2);
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
