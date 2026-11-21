import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PrMonitorAuthority, PrMonitorSubscription } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { AuthSession } from './interactive-auth-core.js';

type Scope = PrMonitorAuthority['scope'];
export type PrWatchRequest = {
  requestId: string;
  conversationId: string;
  subscriptionId: string;
  expectedRevision: number;
  expectedAuthorityRevision: number;
  durationMinutes: number;
  reviewedScope: Scope;
};
type Revoke = Omit<PrWatchRequest, 'durationMinutes' | 'reviewedScope'>;
type Ports = {
  store: EventStore['prMonitor'];
  hasPersistentRevocationAuthority(): boolean;
  isInteractive(loginId: string): boolean;
  isLoginCurrent(auth: AuthSession): boolean;
  assertConversation(subscription: PrMonitorSubscription): void;
  connection(subscription: PrMonitorSubscription): Scope;
};
/** Durable extension of SessionCapabilityGrants, using its interactive Access
 * entrypoint and the existing logout owner. Stored consent is never a login. */
export class PrMonitorConsent {
  private readonly revoking = new Set<string>();
  constructor(private readonly ports: Ports) {}
  private interactive(auth: AuthSession) {
    if (
      !this.ports.hasPersistentRevocationAuthority() ||
      !this.ports.isInteractive(auth.id) ||
      !this.ports.isLoginCurrent(auth)
    )
      throw Error('interactive_authority_required');
  }
  private subscription(conversationId: string, id: string) {
    const s = this.ports.store.read('ordinary:user', conversationId, id).subscription;
    this.ports.assertConversation(s);
    return s;
  }
  issue(auth: AuthSession, input: PrWatchRequest): PrMonitorAuthority {
    this.interactive(auth);
    if (
      this.revoking.has(input.subscriptionId) ||
      this.ports.store.pendingWatchRevocation(input.subscriptionId)
    )
      throw Error('revocation_pending');
    if (
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < 1 ||
      input.durationMinutes > 480
    )
      throw Error('invalid_duration');
    const s = this.subscription(input.conversationId, input.subscriptionId);
    if (s.lifecycle === 'removed' || s.lifecycle === 'merged')
      throw Error('subscription_unavailable');
    const scope = this.ports.connection(s);
    if (
      !isDeepStrictEqual(scope, input.reviewedScope) ||
      scope.connectionId !== s.github.connectionId ||
      scope.connectionRevision !== s.github.identityRevision ||
      scope.repositoryId !== s.github.repositoryId ||
      scope.prNodeId !== s.github.prNodeId
    )
      throw Error('scope_changed');
    return this.ports.store.mutateAuthority({
      ...input,
      operatorId: 'ordinary:user',
      kind: 'pr-watch',
      fingerprint: createHash('sha256')
        .update(JSON.stringify(['issue', auth, input]))
        .digest('hex'),
      assertCurrent: () => {
        this.interactive(auth);
        this.ports.assertConversation(s);
        if (!isDeepStrictEqual(scope, this.ports.connection(s))) throw Error('scope_changed');
      },
      change: (previous) => ({
        version: 1,
        id: previous?.id ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        kind: 'pr-watch',
        subscriptionId: s.id,
        conversationId: s.conversationId,
        issuer: {
          realm: 'ordinary',
          subject: 'user',
          authSessionId: auth.id,
          authExpiresAt: auth.expiresAt,
        },
        scope,
        settingsDigest: null,
        maxAttemptsPerBatch: null,
        maxCommandsPerHour: null,
        expiresAt: Math.min(auth.expiresAt, Date.now() + input.durationMinutes * 60000),
        revokedAt: null,
      }),
    });
  }
  revoke(auth: AuthSession, input: Revoke) {
    this.interactive(auth);
    this.subscription(input.conversationId, input.subscriptionId);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(['revoke', 'ordinary:user', input]))
      .digest('hex');
    this.revoking.add(input.subscriptionId);
    this.ports.store.beginWatchRevocation({
      ...input,
      operatorId: 'ordinary:user',
      fingerprint,
      assertCurrent: () => this.interactive(auth),
    });
    const result = this.ports.store.mutateAuthority({
      ...input,
      operatorId: 'ordinary:user',
      kind: 'pr-watch',
      fingerprint,
      assertCurrent: () => this.interactive(auth),
      change: (previous) => {
        if (!previous) throw Error('authority_unavailable');
        return { ...previous, revision: previous.revision + 1, revokedAt: Date.now() };
      },
    });
    this.revoking.delete(input.subscriptionId);
    return result;
  }
  capture(
    conversationId: string,
    subscriptionId: string,
  ): (() => void) & { authority: PrMonitorAuthority } {
    const saved = this.ports.store.authority(subscriptionId, 'pr-watch');
    if (!saved) throw Error('authority_unavailable');
    const check = () => {
      if (
        this.revoking.has(subscriptionId) ||
        this.ports.store.pendingWatchRevocation(subscriptionId)
      )
        throw Error('authority_unavailable');
      if (!this.ports.hasPersistentRevocationAuthority()) throw Error('authority_unavailable');
      const s = this.subscription(conversationId, subscriptionId);
      const current = this.ports.store.authority(subscriptionId, 'pr-watch');
      if (
        !current ||
        !isDeepStrictEqual(current, saved) ||
        current.revokedAt !== null ||
        current.expiresAt <= Date.now() ||
        !this.ports.isLoginCurrent({
          id: current.issuer.authSessionId,
          expiresAt: current.issuer.authExpiresAt,
        }) ||
        s.lifecycle !== 'watching' ||
        s.watch?.id !== current.id ||
        s.watch.revision !== current.revision
      )
        throw Error('authority_unavailable');
      if (!isDeepStrictEqual(current.scope, this.ports.connection(s)))
        throw Error('connection_unavailable');
    };
    check();
    return Object.assign(check, { authority: saved });
  }
}
