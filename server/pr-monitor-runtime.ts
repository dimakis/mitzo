import { GitHubReadAdmission } from './github-read-admission.js';
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
  const admission = new GitHubReadAdmission(options.eventStore.githubReadQuota);
  const read = createPrMonitorGitHubReader({
    transport: (endpoint, signal, current, request) =>
      admission.read(
        endpoint,
        {
          signal,
          assertCurrent: current,
          principalId: request.principalId,
          connectionId: request.subscription.github.connectionId,
          background: true,
        },
        () => options.transport(endpoint, signal, current, request),
      ),
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
    observeQuota: () => undefined, // The shared transport owner observes before delivery fences.
  });
  const observer = new PrMonitorObserver({
    store: options.eventStore.prMonitor,
    capture: (conversationId, id) => consent.capture(conversationId, id),
    read,
    eligibleAuthors: options.eligibleAuthors,
    reserve: () => undefined, // Observer retains its 16-call/20-second refresh bound.
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
