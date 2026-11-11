import { randomUUID } from 'node:crypto';
import type { EventStore } from './event-store.js';
import { createLogger } from './logger.js';
import { SessionRemovalBlocker } from './session-removal-blocker.js';
const log = createLogger('session-resource-removal');
type SessionRemovalStore = EventStore['removals'];
type SessionRemovalRecord = NonNullable<ReturnType<SessionRemovalStore['read']>>;

/** Coordinates existing runtime and preservation owners. The durable event DB
 * fences admissions; this map only joins work within the current controller. */
export class SessionResourceRemovalService {
  private readonly preparing = new Map<string, Promise<SessionRemovalRecord>>();
  private readonly releasing = new Map<string, Promise<SessionRemovalRecord>>();
  constructor(
    private readonly deps: {
      store: SessionRemovalStore;
      fingerprint(id: string): string;
      assertProtected(id: string): void;
      cancelPrompts(id: string): Promise<void>;
      closeRuntime(id: string): Promise<void>;
      assertSettled(id: string): void;
      restorePrompts?(id: string): void;
    },
  ) {}
  read(id: string) {
    return this.deps.store.read(id);
  }
  assertArchivable(id?: string) {
    this.deps.store.assertArchivable(id);
  }
  isPrepared(id: string) {
    const record = this.read(id);
    if (!record?.preparationCompleted || (record.phase === 'failed' && !record.releaseStarted))
      return false;
    try {
      this.current(id, record, () => {});
      this.deps.assertSettled(id);
      return true;
    } catch {
      return false;
    }
  }
  private current(id: string, record: SessionRemovalRecord, assertCurrent: () => void) {
    assertCurrent();
    this.deps.assertProtected(id);
    if (this.deps.fingerprint(id) !== record.fingerprint)
      throw Error('Chat resources changed. Review the original removal.');
  }
  private recordFailure(
    id: string,
    record: SessionRemovalRecord,
    stage: 'prepare' | 'release',
    error: unknown,
  ) {
    const diagnostic = { stage, sessionId: id, operationId: record.operationId };
    log.warn('Chat removal failed; chat and runtime evidence retained', {
      ...diagnostic,
      code: error instanceof SessionRemovalBlocker ? error.code : `removal_${stage}_failed`,
    });
    try {
      this.deps.store.transition(
        id,
        record.operationId,
        stage === 'prepare' ? 'closing' : 'releasing',
        'failed',
        error instanceof Error ? error.message : 'Chat removal could not be verified.',
      );
    } catch {
      // Keep the original failure and admission fence if its durable diagnostic
      // cannot be saved; report the secondary failure separately.
      log.error('Could not record the chat removal failure', {
        ...diagnostic,
        code: 'removal_failure_record_unavailable',
      });
    }
  }
  async prepare(id: string, assertCurrent: () => void): Promise<SessionRemovalRecord> {
    assertCurrent();
    let task = this.preparing.get(id);
    if (!task) {
      task = this.prepareOwned(id, assertCurrent).finally(() => this.preparing.delete(id));
      this.preparing.set(id, task);
    }
    const record = await task;
    this.current(id, record, assertCurrent);
    return record;
  }
  private async prepareOwned(id: string, assertCurrent: () => void) {
    this.deps.assertProtected(id);
    const previous = this.read(id);
    let record = this.deps.store.begin(
      id,
      previous?.operationId ?? randomUUID(),
      this.deps.fingerprint(id),
    );
    this.current(id, record, assertCurrent);
    if (record.phase === 'completed' || record.releaseStarted) return record;
    if (record.phase === 'failed')
      record = this.deps.store.transition(id, record.operationId, 'failed', 'closing');
    try {
      await this.deps.cancelPrompts(id);
      this.current(id, record, assertCurrent);
      await this.deps.closeRuntime(id);
      this.current(id, record, assertCurrent);
      this.deps.assertSettled(id);
      return this.deps.store.markPrepared(id, record.operationId);
    } catch (error) {
      this.recordFailure(id, record, 'prepare', error);
      throw error;
    }
  }
  async release(
    id: string,
    operationId: string,
    assertCurrent: () => void,
    release: () => Promise<void>,
  ): Promise<SessionRemovalRecord> {
    const preparation = this.preparing.get(id);
    if (preparation) await preparation;
    const prior = this.releasing.get(id);
    if (prior) {
      await prior;
      return this.release(id, operationId, assertCurrent, release);
    }
    const task = this.releaseOwned(id, operationId, assertCurrent, release).finally(() =>
      this.releasing.delete(id),
    );
    this.releasing.set(id, task);
    return task;
  }
  private async releaseOwned(
    id: string,
    operationId: string,
    assertCurrent: () => void,
    release: () => Promise<void>,
  ) {
    let record = this.read(id);
    if (!record || record.operationId !== operationId)
      throw Error('Review this removal before deleting.');
    this.current(id, record, assertCurrent);
    if (record.phase === 'completed') return record;
    if (!record.preparationCompleted)
      throw Error('Complete removal preparation before deleting. Stop and review this chat.');
    this.deps.assertSettled(id);
    if (record.phase === 'failed')
      record = this.deps.store.transition(id, operationId, 'failed', 'closing');
    if (record.phase === 'closing')
      record = this.deps.store.transition(id, operationId, 'closing', 'releasing');
    try {
      this.current(id, record, assertCurrent);
      await release();
      this.current(id, record, assertCurrent);
      return this.deps.store.transition(id, operationId, 'releasing', 'completed');
    } catch (error) {
      this.recordFailure(id, record, 'release', error);
      throw error;
    }
  }
  keep(id: string, operationId: string, assertCurrent: () => void) {
    assertCurrent();
    if (this.preparing.has(id) || this.releasing.has(id))
      throw Error('Wait for the current removal operation.');
    const record = this.read(id);
    if (!record || record.operationId !== operationId || record.releaseStarted)
      throw Error('Resource release has started. Review the original removal.');
    this.deps.restorePrompts?.(id);
    this.deps.store.keep(id, operationId);
  }
}
