import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from '../../server/__tests__/fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from '../../server/__tests__/fixtures/symposium-recording-runtime.js';

// Deliberate mutation controls only. Positive acceptance uses untouched owners.
// Remove each dependency at its actual application factory/adapter; never install
// a successful fake review, preparation, admission or finalized reply owner.
const control = vi.hoisted(() => ({
  omit: '' as 'review' | 'joining' | 'messaging' | 'admission' | 'reply' | '',
  observed: [] as string[],
  requests: new Map<string, unknown>(),
  ports: [] as object[],
}));
vi.mock('../../server/session-collaboration-router.js', async (original) => {
  const actual = await original<typeof import('../../server/session-collaboration-router.js')>();
  return {
    ...actual,
    createSessionCollaborationRouter: (
      options: Parameters<typeof actual.createSessionCollaborationRouter>[0],
    ) => {
      const full = actual.createSessionCollaborationRouter(options);
      const omitted = Object.fromEntries(
        ['review', 'joining', 'messaging'].map((owner) => {
          expect(Reflect.get(options, owner)).toBeTruthy();
          return [
            owner,
            actual.createSessionCollaborationRouter({ ...options, [owner]: undefined }),
          ];
        }),
      );
      return ((req, res, next) => {
        if (req.method === 'POST' && /\/(reviews|joins)$/.test(req.path))
          control.requests.set(req.path.split('/').at(-1)!, structuredClone(req.body));
        const route = omitted[control.omit];
        if (route) control.observed.push(control.omit);
        return (route ?? full)(req, res, next);
      }) as typeof full;
    },
  };
});
vi.mock('../../server/session-prompt-dispatch.js', async (original) => {
  const actual = await original<typeof import('../../server/session-prompt-dispatch.js')>();
  return {
    ...actual,
    createSessionPromptPort: (...args: Parameters<typeof actual.createSessionPromptPort>) => {
      const port = actual.createSessionPromptPort(...args);
      control.ports.push(port);
      return port;
    },
  };
});
vi.mock('../../server/collaboration-ordinary-replies.js', async (original) => {
  const actual = await original<typeof import('../../server/collaboration-ordinary-replies.js')>();
  return {
    ...actual,
    recordOrdinaryReplySource: (...args: Parameters<typeof actual.recordOrdinaryReplySource>) => {
      if (control.omit === 'reply') {
        control.observed.push('reply');
        return;
      }
      return actual.recordOrdinaryReplySource(...args);
    },
  };
});
let journey: ReturnType<typeof createApplicationJourney>;
let runtime: Awaited<ReturnType<typeof recordApplicationMessagingRuntime>> | undefined;
let h: Awaited<ReturnType<ReturnType<typeof createApplicationJourney>['initializeReviewedJoin']>>;
beforeAll(async () => {
  journey = createApplicationJourney();
  h = await journey.initializeReviewedJoin();
  (await import('../../server/auth.js')).setAuthRevocationStore(h.events);
  runtime = await recordApplicationMessagingRuntime(h.events);
  const initial = await h.api.view(h.group);
  const source = initial.policies.find((p) => p.sessionId === 'existing-chat')!;
  await h.api.setPolicy(h.group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: initial.membershipRevision,
    expectedRevision: source.revision,
    sessionId: source.sessionId,
    readsFutureDiscussion: false,
    repliesByDefault: false,
  });
}, 30000);
afterEach(() => {
  control.omit = '';
  control.observed = [];
});
afterAll(async () => {
  if (journey?.state.root) {
    const { registry } = await import('../../server/chat.js');
    for (const [id] of [...registry.entries(true)]) registry.abort(id);
    await vi.waitFor(async () =>
      (await import('../../server/repository-workspace-runtime.js'))
        .getRepositoryWorkspaces(true)
        .closeIdle(),
    );
  }
  runtime?.restore();
  runtime = undefined;
  await journey?.close();
});

it.each(['review', 'joining', 'messaging', 'reply', 'admission'] as const)(
  'control: actual application cannot satisfy acceptance with the %s owner omitted',
  async (omit) => {
    control.omit = omit;
    if (omit === 'review' || omit === 'joining') {
      const suffix = omit === 'review' ? 'reviews' : 'joins';
      const result = await journey.state.http!.request(
        'POST',
        `/api/session-collaborations/${h.group}/${suffix}`,
        {
          headers: { cookie: journey.state.cookie },
          body: control.requests.get(suffix),
        },
      );
      expect(result.status).toBe(503);
      expect(control.observed).toContain(omit);
      expect(journey.state.events.listSessions()).toHaveLength(2);
      expect(runtime!.requests).toHaveLength(0);
      return;
    }
    const view = await h.api.view(h.group);
    const input = {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: 'Required owner mutation control',
      responders: { kind: 'selected' as const, sessionIds: [h.joinedSessionId] },
      snapshot: null,
    };
    if (omit === 'messaging') {
      await expect(h.api.send(h.group, input)).rejects.toThrow();
      expect(runtime!.requests).toHaveLength(0);
    } else {
      if (omit === 'admission') {
        for (const port of control.ports) Reflect.deleteProperty(port, 'deliverOrdinary');
        control.observed.push('admission');
      }
      const accepted = await h.api.send(h.group, input);
      if (omit === 'admission') {
        expect(runtime!.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
        expect(accepted.deliveries[0].status).not.toBe('delivered');
      } else {
        await vi.waitFor(() =>
          expect(
            h.events.getOrdinaryProviderTurnTerminal(
              h.joinedSessionId,
              accepted.deliveries[0].commandId!,
            ),
          ).toBe('completed'),
        );
        expect(runtime!.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
      }
      expect(
        (await h.api.view(h.group)).messages.filter((m) => m.author !== 'operator'),
      ).toHaveLength(0);
    }
    expect(control.observed).toContain(omit);
  },
  30000,
);
