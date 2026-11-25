import { randomUUID } from 'node:crypto';
import {
  ContextMeasurementSchema,
  ContextSnapshotRequestSchema,
  contextSnapshotScopeKey,
  type ContextMeasurement,
  type ContextSnapshotReason,
  type ContextSnapshotRequest,
  type ContextSnapshotResponse,
  type ContextSnapshotOwner,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { createLogger } from './logger.js';

const log = createLogger('context-snapshot');
/** Adapter-owned port on the existing runtime. Never a query/runtime factory.
 * The port object must be replaced for every native query/turn generation.
 */
export type { ContextSnapshotOwner } from '@mitzo/protocol';
export interface ContextSnapshotAuthority {
  /** Host authenticated login/authority identity; never supplied by the request body. */
  key: string;
  current(): boolean;
  allowTokenCount(): Promise<boolean>;
}
class Unavailable extends Error {
  constructor(readonly reason: ContextSnapshotReason) {
    super(reason);
  }
}
interface Pending {
  owner: ContextSnapshotOwner;
  scope: string;
  authority: string;
  generation: unknown;
  controller: AbortController;
  waiters: number;
  result: Promise<ContextSnapshotResponse>;
}

/** Shared lifecycle only. Native adapters retain collection and retirement ownership. */
export class ContextSnapshotLifecycle {
  private readonly pending = new Map<string, Pending>();
  private readonly verified = new WeakMap<
    ContextSnapshotOwner,
    { revision: number; generation: unknown }
  >();
  private readonly now: () => number;
  constructor(
    private readonly options: {
      events: Pick<EventStore, 'contextSnapshots'>;
      current(sessionId: string): ContextSnapshotOwner | undefined;
      generation?(sessionId: string): unknown;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  read(sessionId: string): ContextSnapshotResponse {
    const retained = this.options.events.contextSnapshots.read(sessionId);
    const base = { version: 1 as const, sessionId, revision: retained.revision };
    const owner = this.options.current(sessionId);
    if (!retained.snapshot)
      return { ...base, status: 'unavailable', reason: retained.reason ?? 'not_observed' };
    if (
      owner &&
      contextSnapshotScopeKey(owner.scope) !== contextSnapshotScopeKey(retained.snapshot)
    )
      return { ...base, status: 'unavailable', reason: 'scope_changed' };
    const snapshot = retained.snapshot;
    const verified = owner && this.verified.get(owner);
    const reason =
      retained.reason ??
      (!owner
        ? 'adapter_not_attached'
        : owner.state === 'active'
          ? undefined
          : owner.state === 'retired'
            ? 'query_retired'
            : owner.state) ??
      (verified?.revision !== retained.revision ||
      verified.generation !== this.options.generation?.(sessionId)
        ? 'restored'
        : undefined) ??
      (snapshot.freshness.expiresAt === undefined || snapshot.freshness.expiresAt <= this.now()
        ? 'expired'
        : undefined);
    if (reason || snapshot.freshness.state !== 'current')
      return {
        ...base,
        status: 'stale',
        reason: reason ?? 'expired',
        snapshot: this.stale(snapshot, reason ?? 'expired'),
      };
    return {
      ...base,
      status: snapshot.reconciliation.status === 'consistent' ? 'available' : 'partial',
      snapshot,
    };
  }

  private stale(snapshot: ContextMeasurement, reason: ContextSnapshotReason): ContextMeasurement {
    return {
      ...snapshot,
      freshness: { ...snapshot.freshness, state: 'stale', reason },
      capacity: { ...snapshot.capacity, stale: true },
    };
  }
  inspect(sessionId: string): ContextSnapshotResponse {
    const cached = this.read(sessionId);
    if (
      [...this.pending.values()].some(
        (work) =>
          work.owner.scope.identity.sessionId === sessionId && !work.controller.signal.aborted,
      )
    )
      return { ...cached, status: 'loading' };
    return cached;
  }
  /** Recheck after an await, immediately before transport delivery. */
  forDelivery(response: ContextSnapshotResponse): ContextSnapshotResponse {
    if (['authority_expired', 'scope_changed', 'request_conflict'].includes(response.reason ?? ''))
      return { ...response, snapshot: undefined };
    const current = this.read(response.sessionId);
    if (['available', 'partial'].includes(response.status)) return current;
    return {
      ...response,
      revision: current.revision,
      snapshot: current.snapshot
        ? this.stale(current.snapshot, response.reason ?? 'superseded')
        : undefined,
    };
  }
  private unavailable(sessionId: string, reason: ContextSnapshotReason): ContextSnapshotResponse {
    const cached = this.read(sessionId);
    return {
      ...cached,
      status:
        reason === 'cancelled'
          ? 'cancelled'
          : ['control_failed', 'invalid_response', 'storage_failed'].includes(reason)
            ? 'failed'
            : 'unavailable',
      reason,
      snapshot:
        reason !== 'authority_expired' && reason !== 'scope_changed' && cached.snapshot
          ? this.stale(cached.snapshot, reason)
          : undefined,
    };
  }
  invalidate(sessionId: string, reason: ContextSnapshotReason): void {
    for (const [key, pending] of this.pending)
      if (pending.owner.scope.identity.sessionId === sessionId) {
        pending.controller.abort(new Unavailable(reason));
        this.pending.delete(key);
      }
    const owner = this.options.current(sessionId);
    if (owner) this.verified.delete(owner);
    this.options.events.contextSnapshots.invalidate(sessionId, reason);
  }

  /** Push observations (e.g. Codex last-request events) use the same validation/store owner.
   * They are not converted into occupancy and never start a control/model request.
   */
  observe(owner: ContextSnapshotOwner, raw: unknown): boolean {
    try {
      return this.acceptObservation(owner, raw);
    } catch {
      log.warn('Context snapshot observation rejected', {
        sessionId: owner.scope.identity.sessionId,
        reason: 'observation_rejected',
        stage: 'snapshot_observe',
      });
      return false;
    }
  }
  private acceptObservation(owner: ContextSnapshotOwner, raw: unknown): boolean {
    const sessionId = owner.scope.identity.sessionId;
    const scope = contextSnapshotScopeKey(owner.scope);
    const revision = this.options.events.contextSnapshots.read(sessionId).revision;
    const generation = this.options.generation?.(sessionId);
    const snapshot = this.validate(raw, owner);
    const saved = this.options.events.contextSnapshots.save(
      sessionId,
      snapshot,
      owner.scope,
      revision,
      () => {
        this.assertOwner(sessionId, owner, scope, generation);
      },
    );
    if (saved) this.verified.set(owner, { revision: revision + 1, generation });
    return saved;
  }
  private validate(raw: unknown, owner: ContextSnapshotOwner): ContextMeasurement {
    const snapshot = ContextMeasurementSchema.parse(raw);
    if (
      contextSnapshotScopeKey(snapshot) !== contextSnapshotScopeKey(owner.scope) ||
      snapshot.identity.scope !== 'parent' ||
      snapshot.observedAt > this.now()
    )
      throw new Unavailable('invalid_response');
    return {
      ...snapshot,
      freshness: {
        ...snapshot.freshness,
        expiresAt: Math.min(snapshot.freshness.expiresAt ?? Infinity, snapshot.observedAt + 30_000),
      },
    };
  }
  private assertOwner(
    sessionId: string,
    owner: ContextSnapshotOwner,
    scope: string,
    generation: unknown,
  ): void {
    if (
      this.options.current(sessionId) !== owner ||
      contextSnapshotScopeKey(owner.scope) !== scope ||
      this.options.generation?.(sessionId) !== generation
    )
      throw new Unavailable('scope_changed');
    if (owner.state !== 'active')
      throw new Unavailable(owner.state === 'retired' ? 'query_retired' : owner.state);
    if (owner.scope.identity.sessionId !== sessionId || owner.scope.identity.scope !== 'parent')
      throw new Unavailable('scope_changed');
    if (owner.scope.binding.engine === 'claude' && owner.scope.binding.placement === 'openshell')
      throw new Unavailable('unsupported_route');
  }

  async refresh(
    sessionId: string,
    raw: ContextSnapshotRequest,
    authority: ContextSnapshotAuthority,
    signal: AbortSignal,
  ): Promise<ContextSnapshotResponse> {
    const request = ContextSnapshotRequestSchema.parse(raw);
    try {
      if (signal.aborted) throw new Unavailable('cancelled');
      if (!authority.current()) throw new Unavailable('authority_expired');
      const owner = this.options.current(sessionId);
      if (!owner) throw new Unavailable('adapter_not_attached');
      const scope = contextSnapshotScopeKey(owner.scope);
      const generation = this.options.generation?.(sessionId);
      this.assertOwner(sessionId, owner, scope, generation);
      if (!owner.collect) throw new Unavailable('refresh_unsupported');
      if (request.detail === 'full' && !request.allowTokenCount)
        throw new Unavailable('token_count_not_authorized');
      const cached = this.read(sessionId);
      if (request.detail === 'summary' && ['available', 'partial'].includes(cached.status))
        return cached;
      // Only summaries with the same owner, scope and authenticated authority may share work.
      const key = JSON.stringify([
        sessionId,
        scope,
        authority.key,
        request.detail,
        request.detail === 'full' ? request.requestId : 'summary',
      ]);
      let pending = this.pending.get(key);
      if (
        pending &&
        (pending.owner !== owner ||
          pending.generation !== generation ||
          pending.controller.signal.aborted)
      ) {
        pending.controller.abort(new Unavailable('scope_changed'));
        this.pending.delete(key);
        pending = undefined;
      }
      if (!pending) {
        if (request.detail === 'full') {
          const claim = this.options.events.contextSnapshots.claim(
            sessionId,
            request.requestId,
            JSON.stringify([scope, authority.key, request.detail, request.allowTokenCount]),
          );
          if (claim !== 'claimed')
            throw new Unavailable(claim === 'conflict' ? 'request_conflict' : 'superseded');
        }
        // Bound concurrent inspection memory independently of the number of retained chats.
        if (this.pending.size >= 64) throw new Unavailable('control_failed');
        pending = {
          owner,
          scope,
          generation,
          authority: authority.key,
          controller: new AbortController(),
          waiters: 0,
          result: undefined as unknown as Promise<ContextSnapshotResponse>,
        };
        this.pending.set(key, pending);
        const work = pending;
        pending.result = this.collect(sessionId, request, authority, work).finally(() => {
          if (this.pending.get(key) === work) this.pending.delete(key);
        });
      }
      return await this.wait(sessionId, pending, authority, signal);
    } catch (error) {
      return this.failure(sessionId, error);
    }
  }

  private async collect(
    sessionId: string,
    request: ContextSnapshotRequest,
    authority: ContextSnapshotAuthority,
    pending: Pending,
  ): Promise<ContextSnapshotResponse> {
    const { owner, scope, controller } = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    let finished = false;
    const assertCurrent = () => {
      if (finished) throw new Unavailable('superseded');
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!authority.current()) throw new Unavailable('authority_expired');
      this.assertOwner(sessionId, owner, scope, pending.generation);
    };
    try {
      assertCurrent();
      const revision = this.options.events.contextSnapshots.read(sessionId).revision;
      const bounded = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(new Unavailable('timed_out')), 5000);
      });
      const work = async () => {
        const authorizeFull = async () => {
          assertCurrent();
          const allowed = request.allowTokenCount === true && (await authority.allowTokenCount());
          assertCurrent();
          return allowed;
        };
        if (request.detail === 'full' && !(await authorizeFull()))
          throw new Unavailable('token_count_not_authorized');
        assertCurrent();
        const result = await owner.collect!({
          detail: request.detail,
          signal: controller.signal,
          assertCurrent,
          authorizeFull,
        });
        assertCurrent();
        if (request.detail === 'full' && !(await authorizeFull()))
          throw new Unavailable('token_count_not_authorized');
        assertCurrent();
        if (result.status !== 'available') throw new Unavailable(result.reason);
        let snapshot: ContextMeasurement;
        try {
          snapshot = this.validate(result.snapshot, owner);
        } catch {
          throw new Unavailable('invalid_response');
        }
        let saved: boolean;
        try {
          saved = this.options.events.contextSnapshots.save(
            sessionId,
            snapshot,
            owner.scope,
            revision,
            assertCurrent,
          );
        } catch (error) {
          if (error instanceof Unavailable) throw error;
          throw new Unavailable('storage_failed');
        }
        if (!saved) throw new Unavailable('superseded');
        this.verified.set(owner, { revision: revision + 1, generation: pending.generation });
        return this.read(sessionId);
      };
      return await Promise.race([work(), bounded]);
    } catch (error) {
      return this.failure(sessionId, error);
    } finally {
      finished = true;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  private async wait(
    sessionId: string,
    pending: Pending,
    authority: ContextSnapshotAuthority,
    signal: AbortSignal,
  ): Promise<ContextSnapshotResponse> {
    pending.waiters++;
    let abort = () => {};
    try {
      const result = await Promise.race([
        pending.result,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Unavailable('cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      if (!authority.current()) throw new Unavailable('authority_expired');
      return this.forDelivery(result);
    } finally {
      signal.removeEventListener('abort', abort);
      if (--pending.waiters === 0) pending.controller.abort(new Unavailable('cancelled'));
    }
  }
  private failure(sessionId: string, error: unknown): ContextSnapshotResponse {
    const reason = error instanceof Unavailable ? error.reason : 'control_failed';
    if (['control_failed', 'invalid_response', 'storage_failed'].includes(reason))
      log.warn('Context snapshot refresh unavailable', {
        sessionId,
        reason,
        stage: 'snapshot_refresh',
      });
    return this.unavailable(sessionId, reason);
  }

  /** Adapter awaits this while its native query is alive and retires in its own finally,
   * even if capture/storage fails. No full/token-count fallback is permitted.
   */
  async captureBeforeRetirement(
    sessionId: string,
    authority: ContextSnapshotAuthority,
    signal: AbortSignal,
  ): Promise<ContextSnapshotResponse> {
    const owner = this.options.current(sessionId);
    if (!owner) return this.unavailable(sessionId, 'adapter_not_attached');
    this.invalidate(sessionId, 'turn_completed');
    let result: ContextSnapshotResponse;
    try {
      result = await this.refresh(
        sessionId,
        { requestId: randomUUID(), detail: 'summary' },
        authority,
        signal,
      );
    } finally {
      if (this.options.current(sessionId) === owner) this.invalidate(sessionId, 'turn_completed');
    }
    return ['available', 'partial'].includes(result.status) ? this.read(sessionId) : result;
  }
}
