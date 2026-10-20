/** The Builder's fake EventSource needs a fake control peer, not document HTTP.
 * WebKit can reject an old document's fetch before request interception during
 * reload. Ordinary command and API requests still use the intercepted fetch.
 */
export function builderOfflineTransport(
  origin: string,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  emit: (message: { type: '_probe'; nonce: string }) => void,
) {
  const controls = new Set([
    '/api/chat/switch',
    '/api/chat/reconnect',
    '/api/chat/probe',
    '/api/chat/session-event-applied',
    '/api/chat/reconnect-snapshot-applied',
    '/api/chat/suspend',
  ]);
  return async (url: string, init?: RequestInit) => {
    const target = new URL(url, origin);
    if (
      target.origin !== new URL(origin).origin ||
      init?.method !== 'POST' ||
      !controls.has(target.pathname)
    )
      return fetch(url, init);
    init.signal?.throwIfAborted();
    if (target.pathname === '/api/chat/probe') {
      const { nonce } = JSON.parse(String(init.body));
      if (typeof nonce !== 'string' || !nonce) throw new Error('Invalid offline probe');
      // Match the real HTTP→SSE round trip. An HTTP 200 alone is not a probe ack.
      queueMicrotask(() => emit({ type: '_probe', nonce }));
    }
    return new Response(JSON.stringify({ ok: true, applied: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
