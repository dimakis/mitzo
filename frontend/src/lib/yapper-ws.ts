// WebSocket client for Yapper's streaming transcription endpoint.

export interface TranscriptEvent {
  type: 'partial' | 'final';
  text: string;
}

export interface YapperStreamClient {
  sendFormat: (format: string) => void;
  sendAudio: (data: ArrayBuffer) => void;
  sendEnd: () => void;
  close: () => void;
  onTranscript: ((event: TranscriptEvent) => void) | null;
  onError: ((error: Event) => void) | null;
}

export function createYapperStreamClient(url: string): YapperStreamClient {
  const ws = new WebSocket(url);
  const queue: Array<string | ArrayBuffer> = [];
  let closed = false;
  let finalized = false;
  let failed = false;

  function fail(event: Event) {
    if (closed || finalized || failed) return;
    failed = true;
    queue.length = 0;
    client.onError?.(event);
  }

  ws.onopen = () => {
    if (closed || failed) return;
    // Flush queued messages
    for (const msg of queue) {
      ws.send(msg);
    }
    queue.length = 0;
  };

  ws.onmessage = (e) => {
    try {
      const event: unknown = JSON.parse(e.data);
      if (closed || failed || finalized || !event || typeof event !== 'object') return;
      if ('type' in event && event.type === 'error') {
        fail(new Event('error'));
        return;
      }
      if (
        'type' in event &&
        (event.type === 'partial' || event.type === 'final') &&
        'text' in event &&
        typeof event.text === 'string'
      ) {
        if (event.type === 'final') finalized = true;
        client.onTranscript?.({ type: event.type, text: event.text });
      }
    } catch {
      // Invalid JSON — ignore
    }
  };

  ws.onerror = (e) => {
    fail(e);
  };

  ws.onclose = () => fail(new Event('error'));

  function send(data: string | ArrayBuffer) {
    if (closed || failed || finalized) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      queue.push(data);
    } else {
      fail(new Event('error'));
    }
  }

  const client: YapperStreamClient = {
    onTranscript: null,
    onError: null,

    sendFormat(format: string) {
      send(JSON.stringify({ format }));
    },

    sendAudio(data: ArrayBuffer) {
      send(data);
    },

    sendEnd() {
      send('END');
    },

    close() {
      closed = true;
      queue.length = 0;
      ws.close();
    },
  };

  return client;
}
