import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { PrMonitorDiagnostic, PrMonitorFinding, PrMonitorSubscription } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { createLogger } from './logger.js';
import { prMonitorAuthors, type PrMonitorAuthorPolicy } from './pr-monitor-author-policy.js';
const log = createLogger('pr-monitor');

const ref = z.string().min(1).max(200);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const pullSchema = z.object({
  repositoryId: ref,
  prNodeId: ref,
  owner: ref,
  name: ref,
  number: z.number().int().positive(),
  headSha: sha,
  baseSha: sha,
  title: z.string().max(1024),
  state: z.enum(['open', 'closed', 'merged']),
});
const ciSchema = z.object({
  id: ref,
  headSha: sha,
  slot: ref,
  workflowId: ref.optional(),
  runId: ref,
  runNumber: z.number().int().positive(),
  attempt: z.number().int().positive(),
  status: z.enum(['pending', 'passed', 'failed', 'cancelled', 'neutral', 'skipped']),
  completedAt: z.iso.datetime().nullable(),
});
const reviewSchema = z.object({
  source: z.enum(['review', 'comment']).default('review'),
  id: ref,
  headSha: sha,
  author: ref,
  revision: z.iso.datetime(),
  state: z.enum(['changes_requested', 'approved', 'dismissed', 'commented']),
  findings: z
    .array(z.object({ id: ref, revision: ref, blocking: z.boolean(), resolved: z.boolean() }))
    .max(100),
});
const pageSchema = z.object({ items: z.array(z.unknown()).max(100), hasNext: z.boolean() });
export type PrMonitorReadRequest = {
  method: 'GET';
  resource: 'pr' | 'ci' | 'reviews';
  subscription: PrMonitorSubscription;
  principalId: string;
  page: number;
  headSha?: string;
  maxItems: 100;
  maxBytes: 1048576;
  signal: AbortSignal;
  assertCurrent(): void;
  reserveAdditional(): (() => void) | void;
};
/** The authenticated GitHub owner supplies normalized, head-associated evidence.
 * Reviews need structured finding revision/resolution evidence; free text alone
 * cannot satisfy this port. Missing adapter support stays unavailable. */
export type PrMonitorReadPort = (
  request: PrMonitorReadRequest,
) => Promise<{ status: number; data: unknown; retryAfterMs?: number }>;
type Capture = (() => void) & { authority: { scope: { githubPrincipalId: string } } };
type Options = {
  store: EventStore['prMonitor'];
  capture(conversationId: string, id: string): Capture;
  read: PrMonitorReadPort;
  reserve(request: PrMonitorReadRequest): (() => void) | void;
  eligibleAuthors: PrMonitorAuthorPolicy;
  now?: () => number;
};
class ObservationFailure extends Error {
  constructor(
    readonly code: PrMonitorDiagnostic['code'],
    readonly delay: number | null,
  ) {
    super(code);
  }
}
const lostCustody = (error: unknown) =>
  error instanceof Error &&
  ['observation_claim_lost', 'revision_conflict', 'subscription_unavailable'].includes(
    error.message,
  );
const storageCode = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^SQLITE_[A-Z_]+$/.test(code) ? code : undefined;
};
/** Deterministic observation only. No provider, command, publication or delivery
 * port exists here. The existing scheduler calls reconcile; there is no timer. */
export class PrMonitorObserver {
  private closed = false;
  private readonly controllers = new Set<{ conversationId: string; controller: AbortController }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }
  observe(operatorId: string, conversationId: string, id: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const view = this.options.store.read(operatorId, conversationId, id);
    const key = JSON.stringify([
      operatorId,
      conversationId,
      id,
      view.subscription.revision,
      view.subscription.github.connectionId,
      view.subscription.github.identityRevision,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.collect(view.subscription).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }
  async reconcileDue(): Promise<void> {
    if (this.closed) return;
    for (const s of this.options.store.due(this.now()))
      await this.observe(s.operatorId, s.conversationId, s.id);
  }
  cancelConversation(conversationId: string) {
    for (const entry of this.controllers)
      if (entry.conversationId === conversationId) entry.controller.abort();
  }
  async close() {
    this.closed = true;
    for (const entry of this.controllers) entry.controller.abort();
    await Promise.allSettled(this.inFlight.values());
  }
  private async collect(s: PrMonitorSubscription) {
    const initial = this.options.store.read(s.operatorId, s.conversationId, s.id);
    let claim;
    try {
      claim = this.options.store.leases.acquire(s, this.now());
    } catch (error) {
      log.error('PR observation custody could not be acquired', {
        stage: 'claim',
        code: storageCode(error) ?? 'observation_storage_failed',
        subscriptionId: s.id,
        conversationId: s.conversationId,
      });
      throw error;
    }
    // Another collector owns this revision. This is coalescing, not failure;
    // no authenticated read, quota charge or outbox mutation belongs to us.
    if (!claim) return;
    const entry = { conversationId: s.conversationId, controller: new AbortController() };
    this.controllers.add(entry);
    const signal = AbortSignal.any([AbortSignal.timeout(20000), entry.controller.signal]);
    let requests = 0;
    let operationError: unknown;
    let cleanupError: unknown;
    let stage: 'read' | 'publish' = 'read';
    try {
      const authority = this.options.capture(s.conversationId, s.id);
      const assertCurrent = () => {
        this.options.store.leases.assert(claim, this.now());
        signal.throwIfAborted();
        authority();
      };
      const read = async (
        resource: PrMonitorReadRequest['resource'],
        page = 1,
        headSha?: string,
      ) => {
        assertCurrent();
        if (++requests > 16) throw new ObservationFailure('incomplete', 60000);
        const request: PrMonitorReadRequest = {
          method: 'GET',
          resource,
          subscription: s,
          principalId: authority.authority.scope.githubPrincipalId,
          page,
          headSha,
          maxItems: 100,
          maxBytes: 1048576,
          signal,
          assertCurrent,
          reserveAdditional: () => {
            assertCurrent();
            if (++requests > 16) throw new ObservationFailure('incomplete', 60000);
            return this.options.reserve(request);
          },
        };
        const release = this.options.reserve(request);
        assertCurrent();
        let response: Awaited<ReturnType<PrMonitorReadPort>>;
        let rejectAborted: () => void = () => undefined;
        try {
          const aborted = new Promise<never>((_resolve, reject) => {
            rejectAborted = () => reject(Error('read_failed'));
            signal.addEventListener('abort', rejectAborted, { once: true });
          });
          response = await Promise.race([this.options.read(request), aborted]);
        } finally {
          signal.removeEventListener('abort', rejectAborted);
          release?.();
        }
        assertCurrent();
        if (
          response.status === 429 ||
          (response.status === 403 && response.retryAfterMs !== undefined)
        )
          throw new ObservationFailure(
            'rate_limited',
            Math.max(60000, Math.min(response.retryAfterMs ?? 60000, 86400000)),
          );
        if ([401, 403, 404].includes(response.status))
          throw new ObservationFailure('connection_unavailable', null);
        if (response.status !== 200) throw new ObservationFailure('read_failed', 60000);
        if (Buffer.byteLength(JSON.stringify(response.data)) > request.maxBytes)
          throw new ObservationFailure('incomplete', 60000);
        return response.data;
      };
      const opening = pullSchema.parse(await read('pr'));
      if (
        opening.repositoryId !== s.github.repositoryId ||
        opening.prNodeId !== s.github.prNodeId ||
        opening.number !== s.github.pr ||
        opening.owner.toLowerCase() !== s.github.owner.toLowerCase() ||
        opening.name.toLowerCase() !== s.github.name.toLowerCase()
      )
        throw new ObservationFailure('connection_unavailable', null);
      const pages = async (resource: 'ci' | 'reviews') => {
        const items: unknown[] = [];
        for (let page = 1; ; page++) {
          if (requests >= 14) throw new ObservationFailure('incomplete', 60000);
          const parsed = pageSchema.parse(await read(resource, page, opening.headSha));
          items.push(...parsed.items);
          if (!parsed.hasNext) return items;
        }
      };
      const ci = opening.state === 'open' ? (await pages('ci')).map((c) => ciSchema.parse(c)) : [];
      const reviews =
        opening.state === 'open' ? (await pages('reviews')).map((r) => reviewSchema.parse(r)) : [];
      const closing = pullSchema.parse(await read('pr'));
      const openingIdentity = { ...opening, title: '' };
      const closingIdentity = { ...closing, title: '' };
      if (!isDeepStrictEqual(openingIdentity, closingIdentity))
        throw new ObservationFailure('head_changed', 60000);
      const latest = new Map<string, z.infer<typeof ciSchema>>();
      const workflowRuns = new Map<string, z.infer<typeof ciSchema>>();
      for (const candidate of ci) {
        if (!candidate.workflowId) continue;
        const previous = workflowRuns.get(candidate.workflowId);
        if (
          previous &&
          previous.runNumber === candidate.runNumber &&
          previous.runId !== candidate.runId
        )
          throw new ObservationFailure('incomplete', 60000);
        if (
          !previous ||
          candidate.runNumber > previous.runNumber ||
          (candidate.runNumber === previous.runNumber && candidate.attempt > previous.attempt)
        )
          workflowRuns.set(candidate.workflowId, candidate);
      }
      for (const candidate of ci) {
        if (candidate.headSha !== opening.headSha)
          throw new ObservationFailure('incomplete', 60000);
        const newest = candidate.workflowId ? workflowRuns.get(candidate.workflowId) : undefined;
        if (
          newest &&
          (candidate.runNumber !== newest.runNumber || candidate.attempt !== newest.attempt)
        )
          continue;
        const prior = latest.get(candidate.slot);
        if (prior && prior.runNumber === candidate.runNumber && prior.runId !== candidate.runId)
          throw new ObservationFailure('incomplete', 60000);
        if (
          !prior ||
          candidate.runNumber > prior.runNumber ||
          (candidate.runNumber === prior.runNumber && candidate.attempt > prior.attempt)
        )
          latest.set(candidate.slot, candidate);
        else if (
          candidate.runNumber === prior.runNumber &&
          candidate.attempt === prior.attempt &&
          !isDeepStrictEqual(candidate, prior)
        )
          throw new ObservationFailure('incomplete', 60000);
      }
      const findings: PrMonitorFinding[] = [];
      const url = `https://github.com/${s.github.owner}/${s.github.name}`;
      for (const job of latest.values())
        if (job.status === 'failed') {
          if (!job.completedAt) throw new ObservationFailure('incomplete', 60000);
          findings.push({
            kind: 'ci_failure',
            sourceIds: [`${job.runId}:${job.attempt}:${job.id}:${job.completedAt}:failed`],
            summary: 'Current-head CI job failed.',
            references: [
              {
                kind: 'job',
                id: job.id,
                url: `${url}/actions/runs/${encodeURIComponent(job.runId)}/job/${encodeURIComponent(job.id)}`,
              },
            ],
            truncated: false,
          });
        }
      const currentReviews = new Map<string, z.infer<typeof reviewSchema>>();
      const authors = prMonitorAuthors(this.options.eligibleAuthors, s);
      for (const review of reviews) {
        if (review.state === 'commented') continue;
        if (review.headSha !== opening.headSha || !authors.has(review.author.toLowerCase()))
          continue;
        const author = review.author.toLowerCase();
        const prior = currentReviews.get(author);
        if (!prior || review.revision > prior.revision) currentReviews.set(author, review);
        else if (prior.revision === review.revision && !isDeepStrictEqual(prior, review))
          throw new ObservationFailure('incomplete', 60000);
      }
      for (const review of currentReviews.values())
        if (review.state === 'changes_requested')
          for (const finding of review.findings)
            if (finding.blocking && !finding.resolved)
              findings.push({
                kind: 'review_actionable',
                sourceIds: [
                  `${review.source}:${review.id}:${review.headSha}:${review.revision}:${finding.id}:${finding.revision}`,
                ],
                summary: 'Eligible current-head review has an unresolved blocking finding.',
                references: [
                  {
                    kind: review.source,
                    id: review.id,
                    url:
                      review.source === 'comment'
                        ? `${url}/pull/${s.github.pr}#issuecomment-${review.id}`
                        : `${url}/pull/${s.github.pr}/reviews/${encodeURIComponent(review.id)}`,
                  },
                ],
                truncated: false,
              });
      stage = 'publish';
      this.options.store.publish({
        claim,
        now: this.now,
        operatorId: s.operatorId,
        conversationId: s.conversationId,
        subscriptionId: s.id,
        expectedRevision: s.revision,
        expectedSnapshotRevision: s.snapshotRevision,
        baseline: initial.baselinePending,
        snapshot: {
          title: opening.title,
          state: opening.state,
          headSha: opening.headSha,
          baseSha: opening.baseSha,
          complete: true,
          observedAt: this.now(),
          ci: [...latest.values()].some((j) => j.status === 'failed')
            ? 'failed'
            : [...latest.values()].some((j) => j.status === 'pending')
              ? 'pending'
              : latest.size
                ? [...latest.values()].every((j) => j.status === 'passed')
                  ? 'passed'
                  : 'partial'
                : 'none',
          review: findings.some((f) => f.kind === 'review_actionable') ? 'actionable' : 'none',
        },
        findings,
        assertCurrent,
      });
    } catch (error) {
      operationError = error;
      if (lostCustody(error)) return;
      // Raw transport/review/log diagnostics never enter retained projection.
      const known =
        error instanceof Error &&
        [
          'authority_unavailable',
          'conversation_unavailable',
          'connection_unavailable',
          'quota_delayed',
          'retention_limit',
        ].includes(error.message)
          ? (error.message as PrMonitorDiagnostic['code'])
          : undefined;
      const failure =
        error instanceof ObservationFailure
          ? error
          : new ObservationFailure(
              known ?? 'incomplete',
              known?.endsWith('unavailable') ? null : 60000,
            );
      try {
        this.options.store.fail({
          operatorId: s.operatorId,
          conversationId: s.conversationId,
          subscriptionId: s.id,
          expectedRevision: s.revision,
          expectedSnapshotRevision: s.snapshotRevision,
          claim,
          now: this.now,
          diagnostic: {
            code: failure.code,
            stage,
            nextRefreshAt: failure.delay === null ? null : this.now() + failure.delay,
          },
        });
        log.warn('PR observation could not publish complete evidence', {
          stage,
          code: failure.code,
          causeCode: storageCode(error),
          subscriptionId: s.id,
          conversationId: s.conversationId,
        });
      } catch (persistenceError) {
        if (lostCustody(persistenceError)) return;
        log.error('PR observation failure could not be persisted', {
          stage: 'fail',
          code: storageCode(persistenceError) ?? 'observation_storage_failed',
          observationCode: failure.code,
          subscriptionId: s.id,
          conversationId: s.conversationId,
        });
        throw new AggregateError([error, persistenceError], 'observation_failure_not_persisted', {
          cause: persistenceError,
        });
      }
    } finally {
      this.controllers.delete(entry);
      try {
        this.options.store.leases.release(claim);
      } catch (error) {
        log.error('PR observation custody release is unconfirmed; expiry is required', {
          stage: 'release',
          code: storageCode(error) ?? 'observation_storage_failed',
          subscriptionId: s.id,
          conversationId: s.conversationId,
        });
        cleanupError = error;
      }
    }
    if (cleanupError && !operationError) throw cleanupError;
  }
}
