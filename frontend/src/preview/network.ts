// Imported only by ui-preview.html. No real accounts, messages, or services are contacted.
import { account, metadata, sessions } from './fixtures';
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    location.origin,
  );
  if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
  if (init?.method && init.method !== 'GET')
    return Response.json({ error: 'Preview is read-only' }, { status: 405 });
  if (url.pathname === '/api/inbox') return Response.json([]);
  if (url.pathname === '/api/accounts') return Response.json([account]);
  if (url.pathname.endsWith('/meta')) return Response.json(metadata);
  if (url.pathname === '/api/sessions/search')
    return Response.json({
      results: sessions
        .filter((s) =>
          s.summary.toLowerCase().includes((url.searchParams.get('q') ?? '').toLowerCase()),
        )
        .map((s) => ({
          sessionId: s.id,
          summary: s.summary,
          snippet: 'Sample conversation',
          matchedAt: s.lastModified,
          updatedAt: s.lastModified,
        })),
    });
  if (url.pathname === '/api/sessions') return Response.json({ sessions, hasMore: false });
  if (url.pathname === '/api/service-health')
    return Response.json({ services: [], checkedAt: Date.now() });
  if (url.pathname === '/api/skills')
    return Response.json([
      { name: 'review', description: 'Review the current changes', scope: 'bundled' },
    ]);
  return Response.json({});
};
class PreviewEventSource extends EventTarget {
  readonly readyState = 1;
  private timer: ReturnType<typeof setInterval>;
  constructor() {
    super();
    this.timer = setInterval(() => {
      this.dispatchEvent(new Event('open'));
      this.dispatchEvent(
        new MessageEvent('session_activity', {
          data: JSON.stringify(
            sessions
              .filter((s) => s.isActive)
              .map((s) => ({
                sessionId: s.id,
                clientId: 'preview',
                title: s.summary,
                state: 'waiting',
                waitReason: 'review',
                flags: [],
                lastEventAt: s.lastModified,
              })),
          ),
        }),
      );
    }, 1000);
  }
  readonly url = '';
  readonly withCredentials = false;
  onopen = null;
  onmessage = null;
  onerror = null;
  close() {
    clearInterval(this.timer);
  }
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
}
window.EventSource = PreviewEventSource as unknown as typeof EventSource;
