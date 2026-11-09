import { createHash, randomUUID } from 'node:crypto';
import type { AuthSession } from './auth.js';
import type { EventStore } from '@mitzo/protocol/event-store';

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
    if (operation.auth.id !== auth.id || operation.auth.expiresAt !== auth.expiresAt)
      throw Error('Original deployment operator required');
    if (this.store.active()?.id !== operation.id) throw Error('Original deployment hold required');
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
    return this.serialize(id, 'pause', async () => {
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
        } catch {
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
          value.phase = 'paused';
        });
      return operation;
    });
  }
  activate(id: string, auth: AuthSession, activationId: string) {
    if (this.inFlight) throw Error('Wait for current deployment reconciliation');
    const operation = this.store.get(id);
    this.authorize(operation, auth);
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
    return this.serialize(id, 'resume', async () => {
      let operation = this.store.get(id);
      this.authorize(operation, auth);
      if (!['paused', 'activating', 'resuming'].includes(operation.phase))
        throw Error('Pause must settle before resume');
      if (
        operation.activationHash &&
        (!input.activationId ||
          createHash('sha256').update(input.activationId).digest('hex') !==
            operation.activationHash)
      )
        throw Error('Original activation owner required');
      const expected =
        operation.activationHash && !input.rollback
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
          this.change(id, entry.sessionId, 'resuming', null);
          await this.port.resume(entry, auth, AbortSignal.timeout(120_000), current);
          current();
          if (this.port.receipt(entry) !== 'accepted')
            throw Error('Continuation admission is uncertain');
          this.change(id, entry.sessionId, 'resumed', null);
        } catch {
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
    });
  }
  cancel(id: string, auth: AuthSession) {
    if (this.inFlight) throw Error('Wait for the current deployment operation to settle');
    this.port.authorize(auth);
    const operation = this.store.get(id);
    if (operation.activationHash || operation.phase === 'resuming')
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
