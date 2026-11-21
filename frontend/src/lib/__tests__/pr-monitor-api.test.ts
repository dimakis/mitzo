import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../../../../packages/protocol/src/event-store';
import { createPrMonitorController } from '../../../../server/pr-monitor-controller';
import { createInteractiveAuth } from '../../../../server/interactive-auth-core';
import { readPrMonitors } from '../pr-monitor-api';
import { monitorFixture } from '../../test-utils/pr-monitor-fixture';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../api-fetch', () => ({ apiFetch }));
afterEach(() => vi.restoreAllMocks());

it('consumes the actual controller projection after adapter failure and missed force-push recovery', async () => {
  let now = Date.now();
  const resetAt = Math.floor(now / 1000) + 3600;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'chat' });
  const auth = createInteractiveAuth({
    passphrase: 'offline',
    secret: 'offline-secret-longer-than-thirty-two-characters',
    maxAgeHours: 1,
    cookieName: 'offline',
  });
  auth.setRevocationStore(store);
  const login = (await auth.authenticateToken((await auth.login('offline'))!))!;
  const example = monitorFixture();
  let broken = false;
  let head = 'a'.repeat(40);
  let executionAvailable = true;
  const controller = createPrMonitorController({
    eventStore: store,
    execution: () => {
      if (!executionAvailable) throw Error('conversation_unavailable');
      return example.subscription.execution;
    },
    connection: () => ({
      id: example.subscription.github.connectionId,
      ownerId: 'operator',
      templateId: 'github-readonly',
      status: 'active',
      revision: 1,
      identity: 'owner',
      verifiedAt: 1,
      archivedAt: null,
      desiredAccountIds: ['personal'],
      publicConfig: { allowedRepositories: ['owner/repo'] },
    }),
    auth: {
      hasPersistentRevocationAuthority: auth.hasPersistentRevocationAuthority,
      isInteractive: auth.isAuthenticatedOperatorSessionId,
      isLoginCurrent: (a) => a.expiresAt > Date.now() && !auth.isSessionRevoked(a),
    },
    read: async (endpoint, _signal, current) => {
      current();
      if (broken) throw Error('offline adapter failure');
      return {
        status: 200,
        headers: {
          'x-ratelimit-resource': 'core',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(resetAt),
        },
        data:
          endpoint === '/user'
            ? { id: 42, login: 'owner' }
            : endpoint.includes('/reviews') || endpoint.includes('/comments')
              ? []
              : endpoint.includes('/actions')
                ? { total_count: 0, workflow_runs: [] }
                : {
                    node_id: 'pr-node',
                    number: 7,
                    title: 'Retained PR',
                    state: 'open',
                    merged: false,
                    head: { sha: head },
                    base: {
                      sha: 'b'.repeat(40),
                      repo: { node_id: 'repo-node', name: 'repo', owner: { login: 'owner' } },
                    },
                  },
      };
    },
    eligibleAuthors: ['owner'],
  });
  try {
    const registered = await controller.register(login, 'chat', {
      requestId: 'register',
      connectionId: example.subscription.github.connectionId,
      connectionRevision: 1,
      owner: 'owner',
      name: 'repo',
      pr: 7,
      expectedExecutionDigest: controller.context(login, 'chat').executionDigest,
    });
    controller.consent.issue(login, {
      requestId: 'watch',
      conversationId: 'chat',
      subscriptionId: registered.projection.subscription.id,
      expectedRevision: 1,
      expectedAuthorityRevision: 0,
      durationMinutes: 30,
      reviewedScope: registered.reviewedScope,
    });
    apiFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ...controller.context(login, 'chat'),
            subscriptions: controller.list(login, 'chat'),
          }),
        ),
    );
    await controller.reconcileDue();
    const first = await readPrMonitors('chat');
    expect(first.subscriptions[0].snapshot?.headSha).toBe(head);
    now += 120000;
    broken = true;
    await controller.reconcileDue();
    const failed = (await readPrMonitors('chat')).subscriptions[0];
    expect(failed.refreshState).not.toBe('current');
    expect(failed.diagnostic).not.toBeNull();
    expect(failed.snapshot).toEqual(first.subscriptions[0].snapshot);
    broken = false;
    head = 'c'.repeat(40);
    now += 300000;
    await controller.reconcileDue();
    expect((await readPrMonitors('chat')).subscriptions[0].subscription.head?.sha).toBe(head);
    executionAvailable = false;
    const retained = await readPrMonitors('chat');
    expect(retained.executionAvailable).toBe(false);
    expect(retained.subscriptions).toHaveLength(1);
    expect(retained.subscriptions[0].counters.modelTurns).toBe(0);
  } finally {
    await controller.close();
    store.close();
  }
});

it('rejects malformed, cross-conversation and unsafe-link projections instead of treating them as empty or healthy', async () => {
  for (const value of [
    {},
    {
      executionAvailable: true,
      executionDigest: 'd'.repeat(64),
      subscriptions: [monitorFixture('other')],
    },
    {
      executionAvailable: true,
      executionDigest: 'd'.repeat(64),
      subscriptions: [
        {
          ...monitorFixture(),
          events: [
            {
              ...monitorFixture().events[0],
              references: [{ kind: 'job', id: 'bad', url: 'javascript:alert(1)' }],
            },
          ],
        },
      ],
    },
  ]) {
    apiFetch.mockResolvedValue(new Response(JSON.stringify(value)));
    await expect(readPrMonitors('chat')).rejects.toThrow();
  }
  apiFetch.mockResolvedValue(new Response('{}', { status: 403 }));
  await expect(readPrMonitors('chat')).rejects.toThrow(/access/i);
});
