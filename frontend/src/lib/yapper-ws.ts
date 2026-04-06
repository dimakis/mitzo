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

  ws.onopen = () => {
    // Flush queued messages
    for (const msg of queue) {
      ws.send(msg);
    }
    queue.length = 0;
  };

  ws.onmessage = (e) => {
    try {
      const event: TranscriptEvent = JSON.parse(e.data);
      client.onTranscript?.(event);
    } catch {
      // Invalid JSON — ignore
    }
  };

  ws.onerror = (e) => {
    client.onError?.(e);
  };

  function send(data: string | ArrayBuffer) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else {
      queue.push(data);
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
      ws.close();
    },
  };

  return client;
}
