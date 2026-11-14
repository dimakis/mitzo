import { createServer } from 'node:http';
import type { Express } from 'express';

// Save Node's real transport before application fixtures fence external fetch.
const nativeFetch = globalThis.fetch;

/** Browser EventSource transport adapter over real loopback HTTP. Authentication,
 * SSE framing, connection ownership, reconnect and protocol events stay in the
 * application. This adapter never manufactures a welcome or session event.
 */
export async function applicationEventSource(app: Express, cookie: string) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Loopback listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const fetch = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    return nativeFetch(new URL(url, origin), { ...init, headers });
  };
  const streams = new Set<Stream>();
  let closed = false;
  const receipts: Array<{
    type: string;
    sessionId?: string;
    messageId?: string;
    commandState?: string;
  }> = [];
  class Stream {
    readyState = 0;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    private controller = new AbortController();
    private listeners = new Map<string, Set<(event: { data: string }) => void>>();
    readonly finished: Promise<void>;
    constructor(url: string) {
      streams.add(this);
      this.finished = this.read(url);
    }
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    close() {
      this.readyState = 2;
      this.controller.abort();
    }
    private async read(url: string) {
      try {
        const response = await fetch(url, { signal: this.controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream'))
          throw Error(`Application SSE refused (${response.status})`);
        this.readyState = 1;
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const lines = frame.split('\n');
            const type =
              lines
                .find((line) => line.startsWith('event:'))
                ?.slice(6)
                .trim() ?? 'message';
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const decoded = JSON.parse(data);
            receipts.push({
              type: decoded.type ?? type,
              sessionId: decoded.sessionId,
              messageId: decoded.messageId,
              commandState: decoded.commandState,
            });
            const event = { data };
            if (type === 'message') this.onmessage?.(event);
            for (const listener of this.listeners.get(type) ?? []) listener(event);
          }
        }
        if (!this.controller.signal.aborted) this.onerror?.();
      } catch (error) {
        if (!this.controller.signal.aborted) {
          this.onerror?.();
          throw error;
        }
      } finally {
        streams.delete(this);
      }
    }
  }
  return {
    receipts,
    fetch,
    createEventSource: (url: string) => new Stream(url) as unknown as EventSource,
    async close() {
      if (closed) return;
      closed = true;
      const active = [...streams];
      for (const stream of active) stream.close();
      await Promise.all(active.map((stream) => stream.finished));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
