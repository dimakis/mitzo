import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../../packages/protocol/src/event-store.js';
import { createPrMonitorObservationRuntime } from '../pr-monitor-runtime.js';
const id = '9c6bb0d4-081f-4f55-86f8-60c703452053',
  head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
it.each([0, 3, 5, 7, 8])(
  'composes durable Watch and %i workflows through actual bounded quota admission without a model port',
  async (workflows) => {
    const store = new EventStore(':memory:');
    stores.push(store);
    store.upsertSession({ sessionId: 'chat' });
    store.prMonitor.create('create', {
      version: 1,
      id,
      revision: 1,
      operatorId: 'ordinary:user',
      conversationId: 'chat',
      github: {
        connectionId: id,
        identityRevision: '1',
        repositoryId: 'repo-node',
        prNodeId: 'pr-node',
        owner: 'owner',
        name: 'repo',
        pr: 7,
      },
      execution: {
        binding: {
          version: 2,
          account: { accountId: 'a', provider: 'openai-codex', profileRevision: '1' },
          harness: { implementation: 'codex' },
          execution: { location: 'local', targetId: 'mac', targetRevision: '1' },
        },
        selectionRevision: '1',
        profileRevision: '1',
        workspaceId: 'w',
      },
      head: null,
      watch: null,
      autoFix: null,
      merge: null,
      lifecycle: 'paused',
      lastAttemptAt: null,
      lastSuccessfulRefreshAt: null,
      nextRefreshAt: null,
      snapshotRevision: 0,
      eligibilityRevision: 0,
      eligibilityDigest: '0'.repeat(64),
    });
    const scope = {
      connectionId: id,
      connectionRevision: '1',
      githubPrincipalId: 'github:42',
      repositoryId: 'repo-node',
      prNodeId: 'pr-node',
    };
    const resetAt = Date.now() + 3600000;
    const transport = vi.fn(async (endpoint: string) => ({
      status: 200,
      headers: {
        'x-ratelimit-resource': 'core',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(resetAt / 1000)),
      },
      data:
        endpoint === '/user'
          ? { id: 42 }
          : endpoint.includes('/reviews') || endpoint.includes('/comments')
            ? []
            : endpoint.includes('/jobs')
              ? { total_count: 0, jobs: [] }
              : endpoint.includes('/actions')
                ? {
                    total_count: workflows,
                    workflow_runs: Array.from({ length: workflows }, (_, i) => ({
                      id: i + 1,
                      workflow_id: i + 1,
                      run_number: 1,
                      run_attempt: 1,
                      head_sha: head,
                      status: 'queued',
                      conclusion: null,
                    })),
                  }
                : {
                    node_id: 'pr-node',
                    number: 7,
                    title: 'PR',
                    state: 'open',
                    merged: false,
                    head: { sha: head },
                    base: {
                      sha: base,
                      repo: { node_id: 'repo-node', name: 'repo', owner: { login: 'owner' } },
                    },
                  },
    }));
    const runtime = createPrMonitorObservationRuntime({
      eventStore: store,
      consent: {
        hasPersistentRevocationAuthority: () => true,
        isInteractive: () => true,
        isLoginCurrent: () => true,
        assertConversation: () => undefined,
        connection: () => scope,
      },
      transport,
      eligibleAuthors: ['trusted'],
    });
    runtime.consent.issue(
      { id: 'login', expiresAt: Date.now() + 3600000 },
      {
        requestId: 'issue',
        conversationId: 'chat',
        subscriptionId: id,
        expectedRevision: 1,
        expectedAuthorityRevision: 0,
        durationMinutes: 30,
        reviewedScope: scope,
      },
    );
    await runtime.reconcileDue();
    const view = store.prMonitor.read('ordinary:user', 'chat', id);
    if (workflows === 8) {
      expect(view.refreshState).toBe('partial');
      expect(view.diagnostic?.code).toBe('incomplete');
      expect(view.outbox).toBeNull();
      expect(transport).toHaveBeenCalledTimes(16);
      expect(store.githubReadQuota.inspect('github:42').charged).toBe(16);
      await runtime.close();
      return;
    }
    expect(view.refreshState).toBe('current');
    expect(view.snapshot?.headSha).toBe(head);
    expect(view.counters.modelTurns).toBe(0);
    expect(transport).toHaveBeenCalledTimes(9 + workflows);
    expect(store.githubReadQuota.inspect('github:42').charged).toBe(9 + workflows);
    await runtime.close();
    await runtime.reconcileDue();
    expect(transport).toHaveBeenCalledTimes(9 + workflows);
  },
);
