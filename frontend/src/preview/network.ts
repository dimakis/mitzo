// Imported only by ui-preview.html. No real accounts, messages, or services are contacted.
import { account, metadata, sessions } from './fixtures';
import {
  symposiumReviewPreviewResponses,
  symposiumReviewPreviewHistory,
} from './symposium-review-fixtures';
import { previewProposal, symposiumPerspective, symposiumStatus } from './symposium-fixtures';
const nativeFetch = window.fetch.bind(window);
let deviceState = 'idle';
let deviceExpiresAt = 0;
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    location.origin,
  );
  if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const denied = () => Response.json({ error: 'Unsupported preview request' }, { status: 405 });
  const login = '/api/symposium/personal/login';
  if (url.pathname.startsWith(login)) {
    let body: Record<string, unknown> | undefined;
    if (method === 'POST') {
      try {
        const raw: unknown =
          init?.body !== undefined
            ? JSON.parse(String(init.body))
            : input instanceof Request
              ? await input.clone().json()
              : undefined;
        if (raw && typeof raw === 'object' && !Array.isArray(raw))
          body = raw as Record<string, unknown>;
      } catch {
        return denied();
      }
    }
    if (
      url.pathname === login &&
      method === 'POST' &&
      body?.method === 'device-code' &&
      Object.keys(body).length === 1
    ) {
      deviceState = 'pending';
      deviceExpiresAt = Date.now() + 600000;
    } else if (
      url.pathname === `${login}/cancel` &&
      method === 'POST' &&
      body?.attemptId === 'preview-device' &&
      Object.keys(body).length === 1
    ) {
      deviceState = 'cancelled';
    } else if (url.pathname === `${login}/status` && method === 'GET') {
      const id = url.searchParams.get('attemptId');
      if (id && id !== 'preview-device') return Response.json({ state: 'unknown', attemptId: id });
    } else return denied();
    return Response.json(
      deviceState === 'pending'
        ? {
            state: deviceState,
            attemptId: 'preview-device',
            method: 'device-code',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'DEMO-CODE',
            expiresAt: deviceExpiresAt,
          }
        : {
            state: deviceState,
            ...(deviceState === 'idle' ? {} : { attemptId: 'preview-device' }),
          },
    );
  }
  if (method !== 'GET') return denied();
  if (url.pathname === '/api/connections')
    return Response.json({
      connections: [],
      legacy: [],
      eligibleAccounts: [],
      appliesTo: 'new conversations only',
    });
  if (url.pathname === '/api/connections/templates') return Response.json({ templates: [] });
  if (/^\/api\/sessions\/[^/]+\/symposium\/reviews$/.test(url.pathname)) {
    // preview-1: findings; preview-3: changed artifact; preview-2: unavailable host.
    const sessionId = url.pathname.split('/')[3];
    return Response.json(
      sessionId === 'preview-1'
        ? symposiumReviewPreviewResponses.findings
        : sessionId === 'preview-3'
          ? symposiumReviewPreviewResponses.delta
          : symposiumReviewPreviewResponses.unavailable,
    );
  }
  if (/^\/api\/sessions\/[^/]+\/symposium\/reviews\/[^/]+$/.test(url.pathname)) {
    const sessionId = url.pathname.split('/')[3];
    const workflowId = url.pathname.split('/')[6];
    const scenario =
      sessionId === 'preview-1' ? 'findings' : sessionId === 'preview-3' ? 'delta' : null;
    if (!scenario || workflowId !== 'preview-review')
      return Response.json({ error: 'Review workflow not found' }, { status: 404 });
    return Response.json({
      workflow: symposiumReviewPreviewResponses[scenario].workflows[0],
      history: symposiumReviewPreviewHistory[scenario],
    });
  }
  if (url.pathname === '/api/symposium/profile-proposals')
    return Response.json(
      url.searchParams.get('sessionId') === 'preview-3' ? [previewProposal] : [],
    );
  if (url.pathname === '/api/symposium/profiles')
    return Response.json([
      {
        profileId: 'preview-reviewer',
        revision: 1,
        contentHash: 'preview',
        definition: {
          name: 'Independent reviewer',
          role: 'reviewer',
          instructions: 'Review supplied evidence independently.',
          expectedOutput: 'Findings with evidence',
          acceptanceCriteria: ['Each finding is actionable'],
          modelPolicyRole: 'reviewer',
        },
      },
    ]);
  if (/^\/api\/sessions\/[^/]+\/symposium\/context-turns$/.test(url.pathname))
    return Response.json({
      turns: [
        {
          id: 'delivery:preview-shared',
          content: 'Agreed acceptance criteria: preserve isolated accounts and explicit context.',
          shareable: true,
        },
      ],
    });
  if (
    /^\/api\/symposium\/profiles\/preview-(?:architect|reviewer|implementer)\/1$/.test(url.pathname)
  )
    return Response.json({ definition: previewProposal.definition });
  if (/^\/api\/sessions\/[^/]+\/symposium(?:\/perspectives)?$/.test(url.pathname)) {
    const sessionId = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/perspectives'))
      return Response.json(symposiumPerspective(url.searchParams.get('seatId')));
    if (sessionId === 'preview-1' || sessionId === 'preview-3')
      return Response.json(symposiumStatus(sessionId));
    return Response.json({
      sessionId,
      config: null,
      seats: [],
      runtimeAvailable: false,
      profileBindingEnforced: false,
      reservedSeats: 0,
      capacityRemaining: 3,
      deliveries: [],
    });
  }
  if (url.pathname === '/api/inbox') return Response.json([]);
  if (url.pathname === '/api/accounts' || url.pathname === '/api/symposium/accounts')
    return Response.json([account]);
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
