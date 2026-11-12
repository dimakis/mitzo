import type { SessionLaunchConfig } from '@mitzo/protocol';
import {
  SessionLaunchStore,
  SessionLaunchError,
  SessionLaunchPreflightError,
  type RetainedSessionLaunch,
  type SessionLaunchEdits,
  type SessionLaunchApprovalEffect,
} from './session-launch-store.js';
import { recordSessionLaunchFailure } from './session-launch-diagnostics.js';

/** Supplied only by authenticated controller composition. */
export interface SessionLaunchAuthority {
  operatorConnectionId: string;
  authSessionId: string;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface SessionLaunchPort {
  validate(configuration: SessionLaunchConfig, authority: SessionLaunchAuthority): Promise<void>;
  start(
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
    prepared: (childSessionId: string, preparationId: string) => void,
  ): Promise<void>;
  canResume?(record: RetainedSessionLaunch, authority: SessionLaunchAuthority): Promise<void>;
  resume?(
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
    prepared: (childSessionId: string, preparationId: string) => void,
  ): Promise<void>;
  inspect(
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
  ): Promise<{
    accepted: boolean;
    uncertain?: boolean;
    childSessionId?: string;
    preparationId?: string;
  }>;
}
/** A request-only user approval owns the frozen config. The runtime still owns
 * actual admission, revocation, provider startup and command deduplication. */
export class SessionLaunchService {
  private readonly inFlight = new Set<string>();
  constructor(
    readonly store: SessionLaunchStore,
    readonly port: SessionLaunchPort,
  ) {}
  async refresh(id: string, owner: string, authority: SessionLaunchAuthority) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    const record = this.store.get(id, owner);
    if (this.inFlight.has(id)) return record;
    if (!['starting', 'created', 'uncertain'].includes(record.state)) return record;
    const observed = await this.port.inspect(record, authority);
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    if (observed.childSessionId && observed.preparationId && !record.childSessionId)
      this.store.markPrepared(id, observed.childSessionId, observed.preparationId);
    if (observed.accepted) return this.store.markRunning(id);
    if (observed.uncertain)
      return this.store.fail(
        id,
        'Startup has no confirmed ordinary command receipt. Its retained allocation must be reconciled before another launch.',
        true,
      );
    return this.store.get(id, owner);
  }
  async approve(
    id: string,
    owner: string,
    edits: SessionLaunchEdits,
    expectedRevision: number,
    authority: SessionLaunchAuthority,
    beforeApply?: SessionLaunchApprovalEffect,
  ) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    // Validation may discover unavailable configuration, but cannot allocate.
    const existing = this.store.get(id, owner);
    if (existing.state === 'pending') {
      try {
        await this.port.validate(edits.configuration, authority);
      } catch (cause) {
        authority.assertCurrent();
        authority.signal.throwIfAborted();
        const current = this.store.get(id, owner);
        if (
          current.state !== 'pending' ||
          current.revision !== expectedRevision ||
          current.allocationId
        )
          throw new SessionLaunchError(
            'Request changed. Check the retained request before editing.',
          );
        const known = cause instanceof SessionLaunchError;
        if (!known) recordSessionLaunchFailure(current, 'preflight', cause);
        throw new SessionLaunchPreflightError(
          known
            ? cause.message
            : 'Session configuration could not be checked. Try again after checking the selected account and host.',
          known ? cause.status : 503,
          { cause },
        );
      }
      authority.assertCurrent();
      authority.signal.throwIfAborted();
    }
    const approved = this.store.approve(id, owner, edits, expectedRevision, beforeApply);
    if (!this.store.claimStart(id)) {
      return this.refresh(id, owner, authority);
    }
    return this.run(id, owner, approved, authority, false);
  }
  async resume(
    id: string,
    owner: string,
    expectedRevision: number,
    authority: SessionLaunchAuthority,
  ) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    if (this.inFlight.has(id))
      throw new SessionLaunchError('Startup is still active. Wait for its receipt.');
    const record = this.store.get(id, owner);
    if (record.state !== 'uncertain' || record.revision !== expectedRevision)
      throw new SessionLaunchError('Startup changed. Reload its current receipt before resuming.');
    if (!this.port.canResume || !this.port.resume)
      throw new SessionLaunchError('Safe startup recovery is unavailable.');
    await this.port.validate(record.configuration, authority);
    await this.port.canResume(record, authority);
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    if (this.inFlight.has(id)) throw new SessionLaunchError('Startup is still active.');
    const retained = this.store.claimResume(id, owner, expectedRevision);
    return this.run(id, owner, retained, authority, true);
  }
  private async run(
    id: string,
    owner: string,
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
    resume: boolean,
  ) {
    this.inFlight.add(id);
    try {
      const dispatch = resume ? this.port.resume!.bind(this.port) : this.port.start.bind(this.port);
      await dispatch(record, authority, (childSessionId, preparationId) => {
        authority.assertCurrent();
        authority.signal.throwIfAborted();
        this.store.markPrepared(id, childSessionId, preparationId);
      });
      authority.assertCurrent();
    } catch (cause) {
      recordSessionLaunchFailure(this.store.get(id, owner), resume ? 'resume' : 'start', cause);
      // Startup can fail after workspace/provider effects. Never infer absence
      // from an exception or allocate a replacement on the next approval.
      return this.store.fail(
        id,
        'Launch acknowledgement is unavailable. The retained session and command must be reconciled before another launch.',
        true,
      );
    } finally {
      this.inFlight.delete(id);
    }
    return this.refresh(id, owner, authority);
  }
}
