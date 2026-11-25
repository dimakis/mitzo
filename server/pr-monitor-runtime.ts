import { randomUUID } from 'node:crypto';
import type { EventStore } from './event-store.js';
import { PrMonitorConsent } from './pr-monitor-consent.js';
import { PrMonitorObserver } from './pr-monitor-observer.js';
import { createPrMonitorGitHubReader } from './pr-monitor-github.js';
import type { PrMonitorAuthorPolicy } from './pr-monitor-author-policy.js';

/** Explicit controller composition. The existing prompt scheduler owns tick and
 * drain; the connection owner must supply an attested authenticated transport.
 * This factory performs no live read, activation, model or timer admission. */
export function createPrMonitorObservationRuntime(options: {
  eventStore: EventStore;
  consent: Omit<ConstructorParameters<typeof PrMonitorConsent>[0], 'store'>;
  transport: Parameters<typeof createPrMonitorGitHubReader>[0]['transport'];
  eligibleAuthors: PrMonitorAuthorPolicy;
}) {
  const consent = new PrMonitorConsent({ ...options.consent, store: options.eventStore.prMonitor });
  const quota = options.eventStore.githubReadQuota;
  const read = createPrMonitorGitHubReader({
    transport: options.transport,
    eligibleAuthors: options.eligibleAuthors,
    assertConnection: (request) => {
      const current = options.consent.connection(request.subscription);
      if (
        current.githubPrincipalId !== request.principalId ||
        current.connectionId !== request.subscription.github.connectionId ||
        current.connectionRevision !== request.subscription.github.identityRevision
      )
        throw Error('connection_unavailable');
    },
    observeQuota: (request, response) => {
      const h = response.headers,
        now = Date.now();
      if (h['x-ratelimit-resource'] !== 'core') throw Error('quota_delayed');
      const limit = Number(h['x-ratelimit-limit']),
        remaining = Number(h['x-ratelimit-remaining']),
        resetAt = Number(h['x-ratelimit-reset']) * 1000;
      try {
        quota.observe(
          request.principalId,
          {
            limit,
            remaining,
            resetAt,
            ...(response.retryAfterMs ? { retryAt: now + response.retryAfterMs } : {}),
          },
          now,
        );
      } catch {
        throw Error('quota_delayed');
      }
    },
  });
  const observer = new PrMonitorObserver({
    store: options.eventStore.prMonitor,
    capture: (conversationId, id) => consent.capture(conversationId, id),
    read,
    eligibleAuthors: options.eligibleAuthors,
    reserve: (request) => {
      const now = Date.now(),
        state = quota.inspect(request.principalId),
        requestId = randomUUID();
      quota.reserve({
        requestId,
        principalId: request.principalId,
        connectionId: request.subscription.github.connectionId,
        background: true,
        cost: 1,
        now,
        probe: state.resetAt <= now || state.observedAt < now - 60000,
      });
      return () => quota.finish(requestId);
    },
  });
  return {
    consent,
    observer,
    reconcileDue: () => observer.reconcileDue(),
    close: () => observer.close(),
    stopConversation: (id: string, reason: 'deleted' | 'stopped') => {
      options.eventStore.prMonitor.stopConversation(id, reason);
      observer.cancelConversation(id);
    },
  };
}
