import { createLogger } from './logger.js';
import { findSessionRuntimeError, SessionRuntimeError } from './session-runtime-error.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthSession } from './auth.js';
import type { EventStore } from '@mitzo/protocol/event-store';

const log = createLogger('deployment-coordinator');
function recordFailure(stage: string, operationId: string, sessionId: string, cause: unknown) {
  const failure =
    findSessionRuntimeError(cause) ?? new SessionRuntimeError('recovery_unavailable', { cause });
  log.warn('Deployment reconciliation requires attention', {
    stage,
    operationId,
    sessionId,
    ...failure.telemetry(),
  });
}

type Store = EventStore['deployment'];
type Operation = ReturnType<Store['get']>;
type Entry = Operation['sessions'][number];
export interface DeploymentPort {
  commit(): string;
  authorize(auth: AuthSession): void;
  capture(auth: AuthSession): Array<{ sessionId: string; snapshot: Record<string, unknown> }>;
  validate(entry: Entry, auth: AuthSession): void;
  pause(entry: Entry, auth: AuthSession): Promise<void>;
  settled(entry: Entry, auth: AuthSession): boolean | Promise<boolean>;
  quiescent(): boolean;
  healthy(): boolean;
  receipt(entry: Entry): 'absent' | 'accepted' | 'uncertain';
  resume(
    entry: Entry,
    auth: AuthSession,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void>;
}

/** One operation owns the durable hold. Every action is retryable by identity;
 * an uncertain resume is observed, never automatically sent a second time. */
export class DeploymentCoordinator {
  private inFlight?: { id: string; action: string; promise: Promise<Operation> };
  constructor(
    readonly store: Store,
    private readonly port: DeploymentPort,
  ) {}
  private authorize(operation: Operation, auth: AuthSession) {
    this.port.authorize(auth);
    const current = this.store.active();
    if (current?.id !== operation.id) throw Error('Original deployment hold required');
    if (current.auth.id !== auth.id || current.auth.expiresAt !== auth.expiresAt)
      throw Error('Original deployment operator required');
  }
  private serialize(id: string, action: string, run: () => Promise<Operation>) {
    if (this.inFlight) {
      if (this.inFlight.id === id && this.inFlight.action === action) return this.inFlight.promise;
      return Promise.reject(Error('Deployment reconciliation is already running'));
    }
    const promise = Promise.resolve()
      .then(run)
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = { id, action, promise };
    return promise;
  }
  begin(id: string, targetCommit: string, auth: AuthSession) {
    this.port.authorize(auth);
    const operation = this.store.begin({
      id,
      targetCommit,
      sourceCommit: this.port.commit(),
      auth,
    });
    this.authorize(operation, auth);
    // Capture occurs synchronously after the admission transaction, before any
    // cancellation I/O. A failed capture leaves a visible hold for explicit cancel.
    if (operation.phase === 'capturing') {
      const sessions = this.port.capture(auth);
      return this.store.update(id, (value) => {
        value.phase = 'pausing';
        value.sessions = sessions.map((session) => ({
          ...session,
          interruptId: randomUUID(),
          resumeId: randomUUID(),
          state: 'captured',
          error: null,
        }));
      });
    }
    return operation;
  }
  pause(id: string, auth: AuthSession) {
    return this.serialize(id, `pause:${auth.id}:${auth.expiresAt}`, async () => {
      let operation = this.store.get(id);
      this.authorize(operation, auth);
      if (operation.sourceCommit !== this.port.commit())
        throw Error('Original source release required to pause');
      if (operation.phase === 'paused') return operation;
      if (operation.phase !== 'pausing') throw Error('Deployment is not pausing');
      for (const entry of operation.sessions) {
        this.authorize(operation, auth);
        this.port.validate(entry, auth);
        try {
          if (entry.state === 'captured') {
            this.change(id, entry.sessionId, 'interrupting', null);
            await this.port.pause(entry, auth);
          }
          this.authorize(operation, auth);
          this.port.validate(entry, auth);
          const settled = await this.port.settled(entry, auth);
          this.authorize(operation, auth);
          this.port.validate(entry, auth);
          if (settled) this.change(id, entry.sessionId, 'paused', null);
        } catch (error) {
          recordFailure('pause_settlement', id, entry.sessionId, error);
          this.change(
            id,
            entry.sessionId,
            'blocked',
            'Pause settlement requires attention; no restart authorized',
          );
        }
      }
      operation = this.store.get(id);
      this.authorize(operation, auth);
      if (operation.sessions.every((entry) => entry.state === 'paused') && this.port.quiescent())
        operation = this.store.update(id, (value) => {
          if (value.phase !== 'pausing') throw Error('Deployment phase changed');
          value.phase = 'paused';
        });
      return operation;
    });
  }
  activate(id: string, auth: AuthSession, activationId: string) {
    if (this.inFlight) throw Error('Wait for current deployment reconciliation');
    const operation = this.store.get(id);
    this.authorize(operation, auth);
    if (operation.maintenance) throw Error('Maintenance has separate activation authority');
    const hash = createHash('sha256').update(activationId).digest('hex');
    if (operation.phase === 'activating' && operation.activationHash === hash) return operation;
    if (
      operation.phase !== 'paused' ||
      operation.sourceCommit !== this.port.commit() ||
      !this.port.quiescent()
    )
      throw Error('Original paused source required for activation');
    return this.store.update(id, (value) => {
      value.activationHash = hash;
      value.phase = 'activating';
    });
  }
  resume(id: string, auth: AuthSession, input: { activationId?: string; rollback?: boolean } = {}) {
    return this.serialize(
      id,
      JSON.stringify([
        'resume',
        auth.id,
        auth.expiresAt,
        input.rollback ?? false,
        input.activationId ? createHash('sha256').update(input.activationId).digest('hex') : null,
      ]),
      async () => {
        let operation = this.store.get(id);
        this.authorize(operation, auth);
        if (!['paused', 'activating', 'resuming'].includes(operation.phase))
          throw Error('Pause must settle before resume');
        if (
          this.activationAuthority(operation) &&
          (!input.activationId ||
            createHash('sha256').update(input.activationId).digest('hex') !==
              this.activationAuthority(operation))
        )
          throw Error('Original activation owner required');
        if (
          operation.maintenance &&
          (input.rollback || (operation.phase === 'activating' && !this.port.quiescent()))
        )
          throw Error('Drained maintenance requires quiescent target; rollback is not supported');
        const expected =
          this.activationAuthority(operation) && !input.rollback
            ? operation.targetCommit
            : operation.sourceCommit;
        if (
          (operation.resumeCommit && operation.resumeCommit !== expected) ||
          this.port.commit() !== expected ||
          !this.port.healthy()
        )
          throw Error('Expected healthy release required');
        operation = this.store.update(id, (value) => {
          value.resumeCommit = expected;
          value.phase = 'resuming';
        });
        for (const entry of operation.sessions) {
          const current = () => {
            this.authorize(this.store.get(id), auth);
            this.port.validate(entry, auth);
          };
          try {
            current();
            const receipt = this.port.receipt(entry);
            if (receipt === 'accepted') {
              this.change(id, entry.sessionId, 'resumed', null);
              continue;
            }
            if (
              entry.state === 'resuming' ||
              entry.state === 'uncertain' ||
              receipt === 'uncertain'
            ) {
              this.change(
                id,
                entry.sessionId,
                'uncertain',
                'Original continuation receipt requires reconciliation',
              );
              continue;
            }
            if (entry.state !== 'paused') continue;
            if (!(await this.port.settled(entry, auth)))
              throw Error('Original effects remain unsettled');
            current();
            this.store.update(id, (value) => {
              const original = value.sessions.find(
                (session) => session.sessionId === entry.sessionId,
              )!;
              original.deliveryAttempted = true;
              original.state = 'resuming';
              original.error = null;
            });
            await this.port.resume(entry, auth, AbortSignal.timeout(120_000), current);
            current();
            if (this.port.receipt(entry) !== 'accepted')
              throw Error('Continuation admission is uncertain');
            this.change(id, entry.sessionId, 'resumed', null);
          } catch (error) {
            recordFailure('continuation', id, entry.sessionId, error);
            const receipt = this.port.receipt(entry);
            this.change(
              id,
              entry.sessionId,
              receipt === 'accepted'
                ? 'resumed'
                : receipt === 'uncertain' ||
                    this.store.get(id).sessions.find((s) => s.sessionId === entry.sessionId)
                      ?.state === 'resuming'
                  ? 'uncertain'
                  : 'blocked',
              'Continuation requires attention; no automatic replay',
            );
          }
        }
        operation = this.store.get(id);
        this.authorize(operation, auth);
        if (operation.sessions.every((entry) => entry.state === 'resumed'))
          return this.store.release(id, 'completed');
        return operation;
      },
    );
  }
  reauthorize(id: string, auth: AuthSession, activationId: string) {
    if (this.inFlight) throw Error('Wait for current deployment reconciliation');
    this.port.authorize(auth);
    const operation = this.store.get(id);
    this.assertActivationOwner(operation, activationId);
    if (![operation.sourceCommit, operation.targetCommit].includes(this.port.commit()))
      throw Error('Expected release required');
    for (const entry of operation.sessions) {
      // An accepted original receipt is historical delivery evidence, not new
      // control over a task which may since have changed workspace or closed.
      if (this.port.receipt(entry) !== 'accepted') this.port.validate(entry, auth);
    }
    this.port.authorize(auth);
    return this.store.update(id, (value) => {
      this.port.authorize(auth);
      this.assertActivationOwner(value, activationId);
      value.authHistory = [...(value.authHistory ?? []), { ...value.auth, replacedAt: Date.now() }];
      value.auth = { ...auth };
    });
  }
  reconcileBlocked(id: string, sessionId: string, auth: AuthSession, activationId: string) {
    return this.serialize(
      id,
      JSON.stringify([
        'reconcile',
        sessionId,
        auth.id,
        auth.expiresAt,
        createHash('sha256').update(activationId).digest('hex'),
      ]),
      async () => {
        const operation = this.store.get(id);
        const current = () => {
          this.authorize(operation, auth);
          this.assertActivationOwner(operation, activationId);
        };
        current();
        if (
          operation.phase !== 'resuming' ||
          operation.resumeCommit !== this.port.commit() ||
          !this.port.healthy()
        )
          throw Error('Expected healthy resuming release required');
        const entry = operation.sessions.find((session) => session.sessionId === sessionId);
        if (
          !entry ||
          entry.state !== 'blocked' ||
          (!entry.pauseSettled && !entry.drainedProof) ||
          entry.deliveryAttempted ||
          this.port.receipt(entry) !== 'absent'
        )
          throw Error('Only a blocked never-dispatched continuation can be reconciled');
        this.port.validate(entry, auth);
        if (!(await this.port.settled(entry, auth)))
          throw Error('Original effects remain unsettled');
        current();
        this.port.validate(entry, auth);
        if (this.port.receipt(entry) !== 'absent')
          throw Error('Original continuation receipt changed');
        return this.store.update(id, (value) => {
          current();
          const fresh = value.sessions.find((session) => session.sessionId === sessionId);
          if (
            value.phase !== 'resuming' ||
            !fresh ||
            fresh.state !== 'blocked' ||
            fresh.deliveryAttempted ||
            this.port.receipt(fresh) !== 'absent'
          )
            throw Error('Original blocked continuation changed');
          fresh.state = 'paused';
          fresh.error = null;
        });
      },
    );
  }
  private activationAuthority(operation: Operation): string | undefined {
    if (
      operation.maintenance &&
      (operation.maintenance.kind !== 'drained-handoff-v1' ||
        operation.activationHash ||
        !/^[a-f0-9]{64}$/.test(operation.maintenance.authorityHash))
    )
      throw Error('Complete separate maintenance authority required');
    return operation.maintenance?.authorityHash ?? operation.activationHash;
  }
  private assertActivationOwner(operation: Operation, activationId: string) {
    if (
      !this.activationAuthority(operation) ||
      createHash('sha256').update(activationId).digest('hex') !==
        this.activationAuthority(operation)
    )
      throw Error('Original activation capability required');
  }
  cancel(id: string, auth: AuthSession) {
    if (this.inFlight) throw Error('Wait for the current deployment operation to settle');
    this.port.authorize(auth);
    const operation = this.store.get(id);
    if (operation.maintenance || operation.activationHash)
      throw Error('Activation owner must finish or roll back before releasing admission');
    // Cancellation can release a stale deployment hold, but never resumes a
    // session or deletes uncertainty/interrupt/command history.
    return this.store.release(id, 'cancelled');
  }
  private change(id: string, sessionId: string, state: Entry['state'], error: string | null) {
    return this.store.update(id, (value) => {
      const session = value.sessions.find((item) => item.sessionId === sessionId);
      if (!session) throw Error('Captured deployment session required');
      if (state === 'paused') session.pauseSettled = true;
      session.state = state;
      session.error = error;
    });
  }
}
