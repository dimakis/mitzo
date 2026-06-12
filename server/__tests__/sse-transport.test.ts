import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { SseTransport } from '../sse-transport.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockResponse(): Response {
  const chunks: string[] = [];
  return {
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    writeHead: vi.fn(),
    end: vi.fn(),
    writableEnded: false,
    // Access captured output for assertions
    _chunks: chunks,
  } as unknown as Response & { _chunks: string[] };
}

// ─── SessionSseRegistry ─────────────────────────────────────────────────────

describe('SessionSseRegistry', () => {
  let registry: SessionSseRegistry;

  beforeEach(() => {
    registry = new SessionSseRegistry();
  });

  it('registers and tracks connections', () => {
    const res = mockResponse();
    registry.add('conn-1', res);
    expect(registry.size).toBe(1);
    expect(registry.isOpen('conn-1')).toBe(true);
  });

  it('removes connections', () => {
    const res = mockResponse();
    registry.add('conn-1', res);
    registry.remove('conn-1');
    expect(registry.size).toBe(0);
    expect(registry.isOpen('conn-1')).toBe(false);
  });

  it('closes existing stream when same connectionId re-registers', () => {
    const res1 = mockResponse();
    const res2 = mockResponse();
    registry.add('conn-1', res1);
    registry.add('conn-1', res2);
    expect(registry.size).toBe(1);
    expect(res1.end).toHaveBeenCalled();
  });

  it('sends SSE event with correct format', () => {
    const res = mockResponse() as Response & { _chunks: string[] };
    registry.add('conn-1', res);

    const sent = registry.sendTo('conn-1', { type: 'welcome', protocolVersion: 2 });

    expect(sent).toBe(true);
    expect(res._chunks).toHaveLength(1);
    const frame = res._chunks[0];
    expect(frame).toContain('event: welcome');
    expect(frame).toContain('data: {"type":"welcome","protocolVersion":2}');
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('includes SSE id field when seq provided', () => {
    const res = mockResponse() as Response & { _chunks: string[] };
    registry.add('conn-1', res);

    registry.sendTo('conn-1', { type: 'block_delta', delta: 'hello' }, 42);

    const frame = res._chunks[0];
    expect(frame).toContain('id: 42');
    expect(frame).toContain('event: block_delta');
  });

  it('omits id field when no seq', () => {
    const res = mockResponse() as Response & { _chunks: string[] };
    registry.add('conn-1', res);

    registry.sendTo('conn-1', { type: 'welcome' });

    const frame = res._chunks[0];
    expect(frame).not.toContain('id:');
  });

  it('returns false for unknown connection', () => {
    expect(registry.sendTo('unknown', { type: 'test' })).toBe(false);
  });

  it('removes connection on write failure', () => {
    const res = mockResponse();
    (res.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('socket closed');
    });
    registry.add('conn-1', res);

    const sent = registry.sendTo('conn-1', { type: 'test' });

    expect(sent).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('reports closed when writableEnded', () => {
    const res = mockResponse();
    registry.add('conn-1', res);
    expect(registry.isOpen('conn-1')).toBe(true);

    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    expect(registry.isOpen('conn-1')).toBe(false);
  });

  it('destroy closes all streams', () => {
    const res1 = mockResponse();
    const res2 = mockResponse();
    registry.add('conn-1', res1);
    registry.add('conn-2', res2);

    registry.destroy();

    expect(res1.end).toHaveBeenCalled();
    expect(res2.end).toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });
});

// ─── SseTransport ────────────────────────────────────────────────────────────

describe('SseTransport', () => {
  let sseRegistry: SessionSseRegistry;
  let transport: SseTransport;
  let res: Response & { _chunks: string[] };

  beforeEach(() => {
    sseRegistry = new SessionSseRegistry();
    res = mockResponse() as Response & { _chunks: string[] };
    sseRegistry.add('conn-1', res);
    transport = new SseTransport('conn-1', sseRegistry);
  });

  it('implements SessionTransport.send()', () => {
    transport.send({ type: 'message_start', messageId: 'msg-1' });

    expect(res._chunks).toHaveLength(1);
    expect(res._chunks[0]).toContain('event: message_start');
  });

  it('passes seq as SSE id field', () => {
    transport.send({ type: 'block_delta', seq: 7, delta: 'hi' });

    expect(res._chunks[0]).toContain('id: 7');
  });

  it('implements SessionTransport.isOpen()', () => {
    expect(transport.isOpen()).toBe(true);

    sseRegistry.remove('conn-1');
    expect(transport.isOpen()).toBe(false);
  });

  it('send without seq omits id field', () => {
    transport.send({ type: 'session_end', sessionId: 's-1' });

    expect(res._chunks[0]).not.toContain('id:');
  });
});
