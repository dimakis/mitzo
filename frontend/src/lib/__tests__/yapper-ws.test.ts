import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createYapperStreamClient } from '../yapper-ws';

// --- Mock WebSocket ---

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: (() => void) | null = null;

  sent: Array<string | ArrayBuffer> = [];

  constructor(public url: string) {
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Test helper: simulate server message
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }
}

let lastWs: MockWebSocket;

function captureWs(ws: MockWebSocket) {
  lastWs = ws;
}

beforeEach(() => {
  vi.stubGlobal(
    'WebSocket',
    class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        captureWs(this); // eslint: no-this-alias workaround
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createYapperStreamClient', () => {
  it('connects to the given URL', async () => {
    createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    expect(lastWs.url).toBe('ws://localhost:8700/v1/transcribe/stream');
  });

  it('sendFormat sends a JSON text frame', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    await new Promise((r) => setTimeout(r, 0));

    client.sendFormat('webm/opus');
    expect(lastWs.sent[0]).toBe('{"format":"webm/opus"}');
  });

  it('sendAudio sends binary data', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    await new Promise((r) => setTimeout(r, 0));

    const data = new ArrayBuffer(100);
    client.sendAudio(data);
    expect(lastWs.sent[0]).toBe(data);
  });

  it('sendEnd sends "END" text frame', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    await new Promise((r) => setTimeout(r, 0));

    client.sendEnd();
    expect(lastWs.sent[0]).toBe('END');
  });

  it('fires onTranscript for partial events', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    const onTranscript = vi.fn();
    client.onTranscript = onTranscript;
    await new Promise((r) => setTimeout(r, 0));

    lastWs.simulateMessage('{"type":"partial","text":"hello"}');

    expect(onTranscript).toHaveBeenCalledWith({ type: 'partial', text: 'hello' });
  });

  it('fires onTranscript for final events', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    const onTranscript = vi.fn();
    client.onTranscript = onTranscript;
    await new Promise((r) => setTimeout(r, 0));

    lastWs.simulateMessage('{"type":"final","text":"hello world"}');

    expect(onTranscript).toHaveBeenCalledWith({ type: 'final', text: 'hello world' });
  });

  it('fires onError on WebSocket error', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    const onError = vi.fn();
    client.onError = onError;
    await new Promise((r) => setTimeout(r, 0));

    lastWs.simulateError();

    expect(onError).toHaveBeenCalled();
  });

  it('close() closes the WebSocket', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');
    await new Promise((r) => setTimeout(r, 0));

    client.close();
    expect(lastWs.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('queues sends until WebSocket is open', async () => {
    const client = createYapperStreamClient('ws://localhost:8700/v1/transcribe/stream');

    // Send before open
    client.sendFormat('webm/opus');
    client.sendAudio(new ArrayBuffer(10));

    // Nothing sent yet (WS still connecting)
    expect(lastWs.sent).toHaveLength(0);

    // Simulate open
    await new Promise((r) => setTimeout(r, 0));

    // Now queued messages should be flushed
    expect(lastWs.sent).toHaveLength(2);
  });
});
