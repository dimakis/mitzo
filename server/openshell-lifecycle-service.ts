import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  OpenShellLifecyclePolicy,
  OpenShellLifecycleRecord,
  OpenShellLifecycleStore,
} from './openshell-lifecycle.js';
import { sharedOpenShellLifecycleCoordinator } from './openshell-lifecycle.js';

/** The service deliberately knows no CLI flags. Runtime/checkpoint adapters are
 * injected so the policy remains testable and an unavailable control plane is a
 * preservation blocker rather than an empty inventory. */
export type LifecycleBlocker =
  | 'active_session'
  | 'live_execution'
  | 'startup_or_reconnect'
  | 'queued_work'
  | 'task_board'
  | 'symposium'
  | 'ambiguous_ownership'
  | 'unknown_activity'
  | 'dirty_or_uncheckpointed'
  | 'checkpoint_unavailable'
  | 'transitional_sandbox'
  | 'inventory_unavailable';
export interface LifecycleProtection {
  blockers: LifecycleBlocker[];
}
export interface LifecycleSandbox {
  id: string;
  resourceVersion?: string;
  phase: 'Ready' | 'Stopped' | 'Error' | 'Pending' | 'Creating' | 'Starting' | 'Deleting';
}
export interface LifecycleAdapters {
  inspect(
    record: OpenShellLifecycleRecord,
    signal: AbortSignal,
  ): Promise<LifecycleSandbox | undefined>;
  protect(record: OpenShellLifecycleRecord, signal: AbortSignal): Promise<LifecycleProtection>;
  checkpoint?(
    record: OpenShellLifecycleRecord,
    sandbox: LifecycleSandbox,
    signal: AbortSignal,
  ): Promise<OpenShellLifecycleRecord['checkpoint']>;
  verifyCheckpoint?(
    record: OpenShellLifecycleRecord,
    sandbox: LifecycleSandbox,
    signal: AbortSignal,
  ): Promise<boolean>;
  stop(
    record: OpenShellLifecycleRecord,
    signal: AbortSignal,
    activityUnchanged?: () => boolean,
  ): Promise<void>;
  delete(
    record: OpenShellLifecycleRecord,
    signal: AbortSignal,
    stateUnchanged?: () => boolean,
  ): Promise<void>;
  now?(): number;
  /** Explicit persisted operator consent. It is never inferred from an env var. */
  consent?(record: OpenShellLifecycleRecord): boolean;
  /** Called when an isolated reconciliation failure leaves a record fenced. */
  onReconcileError?(record: OpenShellLifecycleRecord, error: unknown): void;
  /** Called only after a stop or deletion has been durably recorded. */
  onOutcome?(record: OpenShellLifecycleRecord, action: 'stopped' | 'deleted'): void;
}
export interface LifecyclePreview {
  token: string;
  expiresAt: number;
  record: OpenShellLifecycleRecord;
  action: 'stop' | 'stop_and_delete' | 'delete' | 'none';
  blockers: LifecycleBlocker[];
  retention: { enabled: boolean; deleteAfter: number | null; days: number };
}

function blockersFor(
  record: OpenShellLifecycleRecord,
  sandbox: LifecycleSandbox | undefined,
  protection: LifecycleProtection,
  legacyQualified = false,
): LifecycleBlocker[] {
  const blockers = [...protection.blockers];
  if (record.legacyDeletionPending && !legacyQualified) blockers.push('ambiguous_ownership');
  if (!sandbox) blockers.push('inventory_unavailable');
  else if (
    sandbox.phase === 'Error' ||
    sandbox.phase === 'Pending' ||
    sandbox.phase === 'Creating' ||
    sandbox.phase === 'Starting' ||
    sandbox.phase === 'Deleting'
  )
    blockers.push('transitional_sandbox');
  if (!record.physicalSandboxId || !sandbox || sandbox.id !== record.physicalSandboxId)
    blockers.push('ambiguous_ownership');
  if (
    record.phase === 'stopped' &&
    (!record.stoppedResourceVersion || sandbox?.resourceVersion !== record.stoppedResourceVersion)
  )
    blockers.push('ambiguous_ownership');
  if (!record.lastActivityAt || !Number.isFinite(record.lastActivityAt))
    blockers.push('unknown_activity');
  if (!record.identity) blockers.push('ambiguous_ownership');
  return [...new Set(blockers)];
}

/** Serial actions are taken by the shared coordinator before entering here. Each
 * mutation re-reads both protection and physical identity immediately beforehand. */
export class OpenShellLifecycleService {
  private previews = new Map<
    string,
    {
      conversationId: string;
      generation: number;
      sandboxId: string;
      action: Exclude<LifecyclePreview['action'], 'none'>;
      intent: 'policy' | 'delete';
      expiresAt: number;
      used: boolean;
      legacy?: {
        record: OpenShellLifecycleRecord;
        read(): OpenShellLifecycleRecord;
      };
    }
  >();
  constructor(
    private store: OpenShellLifecycleStore,
    private policy: OpenShellLifecyclePolicy,
    private adapters: LifecycleAdapters,
  ) {}
  inventory() {
    return this.store.list().map((record) => ({
      conversationId: record.conversationId,
      sandboxName: record.sandboxName,
      physicalId: record.physicalSandboxId,
      state: record.phase,
      account: record.accountProvider,
    }));
  }
  private now() {
    return this.adapters.now?.() ?? Date.now();
  }
  private consented(record: OpenShellLifecycleRecord) {
    return this.adapters.consent?.(record) === true;
  }
  private markFailed(record: OpenShellLifecycleRecord, error: unknown) {
    if (
      record.phase !== 'checkpointing' &&
      record.phase !== 'stopping' &&
      record.phase !== 'deleting'
    )
      return;
    this.store.fail(
      record.conversationId,
      record.generation,
      record.phase,
      error instanceof Error ? error.message : 'OpenShell lifecycle action failed',
    );
  }
  private prunePreviews() {
    const now = this.now();
    for (const [token, preview] of this.previews)
      if (preview.used || preview.expiresAt < now) this.previews.delete(token);
  }
  async setRetentionConsent(conversationId: string, consent: boolean) {
    return sharedOpenShellLifecycleCoordinator.admit(conversationId, async () => {
      const record = this.store.get(conversationId);
      if (!record) throw new Error('OpenShell lifecycle conversation is unavailable');
      this.store.upsert({
        ...record,
        generation: record.generation + 1,
        retentionConsent: consent,
      });
    });
  }
  /** Call exactly once during startup, before the reconciler accepts work. */
  recoverStartup() {
    this.store.reconcileInterrupted();
  }
  private async state(
    record: OpenShellLifecycleRecord,
    signal: AbortSignal,
    legacyQualified = false,
  ) {
    const sandbox = await this.adapters.inspect(record, signal);
    const protection = await this.adapters.protect(record, signal);
    return { sandbox, blockers: blockersFor(record, sandbox, protection, legacyQualified) };
  }
  async preview(
    conversationId: string,
    signal: AbortSignal,
    intent: 'policy' | 'delete' = 'policy',
  ): Promise<LifecyclePreview> {
    this.prunePreviews();
    const record = this.store.get(conversationId);
    if (!record) throw new Error('OpenShell lifecycle record not found');
    return this.previewRecord(record, signal, intent);
  }
  /** Review alone must not enroll historical resources in automatic idle cleanup.
   * Retain the qualified evidence in a short-lived token; enroll only after
   * explicit confirmation re-reads it under the conversation mutation fence. */
  async previewLegacyDeletion(read: () => OpenShellLifecycleRecord, signal: AbortSignal) {
    this.prunePreviews();
    const record = structuredClone(read());
    if (this.store.get(record.conversationId))
      throw new Error('Sandbox ownership changed; review deletion again');
    const preview = await this.previewRecord(record, signal, 'delete');
    if (preview.action !== 'none') this.previews.get(preview.token)!.legacy = { record, read };
    return preview;
  }
  private async previewRecord(
    record: OpenShellLifecycleRecord,
    signal: AbortSignal,
    intent: 'policy' | 'delete',
    legacyQualified = false,
  ): Promise<LifecyclePreview> {
    const conversationId = record.conversationId;
    const { sandbox, blockers } = await this.state(record, signal, legacyQualified);
    // A historical stopped sandbox has no verified archive. Reviewing it must
    // never start it or authorize deletion without capturing its contents.
    if (record.phase === 'retained' && sandbox?.phase === 'Stopped' && !record.checkpoint)
      blockers.push('checkpoint_unavailable');
    const action: LifecyclePreview['action'] =
      !this.policy.enabled || blockers.length
        ? 'none'
        : record.phase === 'retained' && sandbox?.phase === 'Ready'
          ? intent === 'delete'
            ? 'stop_and_delete'
            : 'stop'
          : record.phase === 'stopped' &&
              sandbox?.phase === 'Stopped' &&
              (intent === 'delete' ||
                (this.consented(record) && this.policy.retentionEligible(record, this.now())))
            ? 'delete'
            : 'none';
    const token = randomUUID();
    const expiresAt = this.now() + 5 * 60_000;
    if (action !== 'none' && sandbox)
      this.previews.set(token, {
        conversationId,
        generation: record.generation,
        sandboxId: sandbox.id,
        action,
        intent,
        expiresAt,
        used: false,
      });
    return {
      token,
      expiresAt,
      record,
      action,
      blockers,
      retention: {
        enabled: this.consented(record),
        deleteAfter: record.stoppedAt === null ? null : record.stoppedAt + this.policy.retentionMs,
        days: this.policy.retentionMs / 86_400_000,
      },
    };
  }
  async confirm(token: string, signal: AbortSignal, expectedConversationId?: string) {
    const preview = this.previews.get(token);
    if (!preview) throw new Error('OpenShell lifecycle preview is expired or already used');
    if (expectedConversationId !== undefined && preview.conversationId !== expectedConversationId)
      throw new Error('OpenShell lifecycle preview belongs to another conversation');
    if (expectedConversationId !== undefined && preview.intent !== 'delete')
      throw new Error('Explicit sandbox deletion review is required');
    return sharedOpenShellLifecycleCoordinator.mutate(preview.conversationId, () =>
      this.confirmLocked(token, signal),
    );
  }
  private async confirmLocked(
    token: string,
    signal: AbortSignal,
    verifyLegacy?: () => void,
  ): Promise<'stopped' | 'deleted'> {
    const preview = this.previews.get(token);
    if (!preview || preview.used || preview.expiresAt < this.now())
      throw new Error('OpenShell lifecycle preview is expired or already used');
    preview.used = true;
    let record = this.store.get(preview.conversationId);
    if (preview.legacy) {
      const legacy = preview.legacy;
      verifyLegacy = () => {
        try {
          if (!isDeepStrictEqual(legacy.read(), legacy.record))
            throw new Error('Legacy sandbox ownership changed; review deletion again');
        } catch (error) {
          const current = this.store.get(legacy.record.conversationId);
          if (
            current?.phase === 'stopped' &&
            current.physicalSandboxId === legacy.record.physicalSandboxId &&
            isDeepStrictEqual(current.identity, legacy.record.identity)
          )
            this.store.failStoppedCheckpoint(
              current.conversationId,
              current.generation,
              'Legacy sandbox ownership changed during deletion',
            );
          throw error;
        }
      };
      if (record) throw new Error('Legacy sandbox ownership changed; review deletion again');
      verifyLegacy();
      record = legacy.record;
    }
    if (!record || record.generation !== preview.generation)
      throw new Error('OpenShell lifecycle preview is stale');
    const explicitDeletion = preview.intent === 'delete';
    if (preview.action === 'delete' && !explicitDeletion && !this.consented(record))
      throw new Error('OpenShell lifecycle consent is required');
    const { sandbox, blockers } = await this.state(record, signal, !!verifyLegacy);
    verifyLegacy?.();
    if (!sandbox || sandbox.id !== preview.sandboxId || blockers.length)
      throw new Error('OpenShell lifecycle preservation check failed');
    if (preview.action === 'stop' || preview.action === 'stop_and_delete') {
      if (sandbox.phase !== 'Ready') throw new Error('OpenShell lifecycle preview is stale');
      if (preview.legacy) {
        // Recheck after asynchronous protection reads, immediately before the
        // first write. Never replace concurrently registered management state.
        if (this.store.get(record.conversationId))
          throw new Error('Legacy sandbox ownership changed; review deletion again');
        this.store.upsert({ ...record, legacyDeletionPending: true });
      }
      const checkpointing = this.store.transition(
        record.conversationId,
        record.generation,
        'checkpointing',
      );
      if (!checkpointing) throw new Error('OpenShell lifecycle generation changed');
      let transient = checkpointing;
      try {
        const checkpoint =
          (await this.adapters.checkpoint?.(checkpointing, sandbox, signal)) ?? null;
        const checkpointed = checkpoint
          ? this.store.saveCheckpoint(checkpointing.conversationId, checkpointing.generation, {
              ...checkpoint,
              sourceResourceVersion: sandbox.resourceVersion,
            })
          : null;
        if (checkpointed) transient = checkpointed;
        if (
          !checkpointed ||
          !(await this.adapters.verifyCheckpoint?.(checkpointed, sandbox, signal))
        )
          throw new Error('OpenShell checkpoint is unavailable');
        const afterCheckpoint = await this.state(checkpointed, signal, !!verifyLegacy);
        verifyLegacy?.();
        // Ready resource versions are observation counters, so a second
        // inspect can advance one without a workspace mutation. `mutate()`
        // holds the per-conversation admission lock across capture and stop;
        // recheck durable identity, phase, and protection instead.
        if (
          !afterCheckpoint.sandbox ||
          afterCheckpoint.sandbox.id !== sandbox.id ||
          afterCheckpoint.sandbox.phase !== 'Ready' ||
          afterCheckpoint.blockers.length
        )
          throw new Error('OpenShell state changed while checkpointing');
        const stopping = this.store.transition(
          record.conversationId,
          checkpointed.generation,
          'stopping',
        );
        if (!stopping) throw new Error('OpenShell lifecycle generation changed');
        transient = stopping;
        let stoppedGeneration: number | undefined;
        try {
          const activityGeneration = sharedOpenShellLifecycleCoordinator.activityGeneration(
            record.conversationId,
          );
          await this.adapters.stop({ ...stopping, checkpoint }, signal, () => {
            verifyLegacy?.();
            const current = this.store.get(record.conversationId);
            return (
              current?.phase === 'stopping' &&
              current.generation === stopping.generation &&
              sharedOpenShellLifecycleCoordinator.activityGeneration(record.conversationId) ===
                activityGeneration
            );
          });
          const stopped = await this.adapters.inspect(stopping, signal);
          if (!stopped || stopped.id !== stopping.physicalSandboxId || stopped.phase !== 'Stopped')
            throw new Error('OpenShell stop could not be verified');
          const stoppedRecord = {
            ...stopping,
            phase: 'stopped',
            generation: stopping.generation + 1,
            checkpoint: checkpointed.checkpoint,
            stoppedAt: this.now(),
            idleSince: stopping.idleSince ?? this.now(),
            stoppedResourceVersion: stopped.resourceVersion,
          } as const;
          this.store.upsert(stoppedRecord);
          stoppedGeneration = stoppedRecord.generation;
          this.adapters.onOutcome?.(stoppedRecord, 'stopped');
          if (preview.action === 'stop_and_delete') {
            const deletion = verifyLegacy
              ? await this.previewRecord(stoppedRecord, signal, 'delete', true)
              : await this.preview(record.conversationId, signal, 'delete');
            if (deletion.action !== 'delete')
              throw new Error('Sandbox stopped; deletion is blocked. Refresh to review.');
            // Keep the same mutation fence across capture, stop and deletion.
            return await this.confirmLocked(deletion.token, signal, verifyLegacy);
          }
          return 'stopped';
        } catch (error) {
          if (verifyLegacy && stoppedGeneration !== undefined)
            this.store.failStoppedCheckpoint(
              record.conversationId,
              stoppedGeneration,
              error instanceof Error ? error.message : 'Legacy deletion continuation failed',
            );
          this.markFailed(stopping, error);
          throw error;
        }
      } catch (error) {
        this.markFailed(transient, error);
        throw error;
      }
    }
    if (
      sandbox.phase !== 'Stopped' ||
      (!explicitDeletion && !this.policy.retentionEligible(record, this.now())) ||
      !record.checkpoint ||
      (!explicitDeletion && !this.consented(record))
    )
      throw new Error('OpenShell lifecycle preview is stale');
    let checkpointVerified: boolean;
    try {
      checkpointVerified =
        (await this.adapters.verifyCheckpoint?.(record, sandbox, signal)) === true;
    } catch (error) {
      this.store.failStoppedCheckpoint(
        record.conversationId,
        record.generation,
        error instanceof Error ? error.message : 'OpenShell checkpoint is unavailable',
      );
      throw error;
    }
    if (!checkpointVerified) {
      const error = new Error('OpenShell checkpoint is unavailable');
      this.store.failStoppedCheckpoint(record.conversationId, record.generation, error.message);
      throw error;
    }
    const beforeDelete = await this.state(record, signal, !!verifyLegacy);
    verifyLegacy?.();
    if (
      !beforeDelete.sandbox ||
      beforeDelete.sandbox.id !== preview.sandboxId ||
      beforeDelete.blockers.length ||
      (!explicitDeletion && !this.consented(record))
    )
      throw new Error('OpenShell lifecycle preservation check failed');
    const deleting = this.store.transition(record.conversationId, record.generation, 'deleting');
    if (!deleting) throw new Error('OpenShell lifecycle generation changed');
    try {
      const activityGeneration = sharedOpenShellLifecycleCoordinator.activityGeneration(
        record.conversationId,
      );
      await this.adapters.delete(deleting, signal, () => {
        verifyLegacy?.();
        const current = this.store.get(record.conversationId);
        return (
          current?.phase === 'deleting' &&
          current.generation === deleting.generation &&
          (explicitDeletion || this.consented(current)) &&
          sharedOpenShellLifecycleCoordinator.activityGeneration(record.conversationId) ===
            activityGeneration
        );
      });
      if (await this.adapters.inspect(deleting, signal))
        throw new Error('OpenShell delete could not be verified absent');
      const deletedRecord = {
        ...deleting,
        phase: 'deleted',
        generation: deleting.generation + 1,
      } as const;
      this.store.upsert(deletedRecord);
      this.adapters.onOutcome?.(deletedRecord, 'deleted');
      return 'deleted';
    } catch (error) {
      this.markFailed(deleting, error);
      throw error;
    }
  }
  async reconcile(signal: AbortSignal) {
    if (!this.policy.enabled) return [] as LifecyclePreview[];
    const previews: LifecyclePreview[] = [];
    for (const record of this.store.list()) {
      if (record.phase !== 'retained' && record.phase !== 'stopped') continue;
      // Retention consent authorizes destructive deletion only. Checkpointing
      // and stopping an idle retained sandbox remain safe without it.
      if (record.phase === 'stopped' && !this.consented(record)) continue;
      try {
        if (record.phase === 'retained') {
          // Close callbacks are not guaranteed across process loss. Observe a
          // fresh, protected idle interval instead of backdating from activity.
          const { blockers } = await this.state(record, signal);
          if (blockers.length || record.idleSince === null) {
            await sharedOpenShellLifecycleCoordinator.admit(record.conversationId, async () => {
              const current = this.store.get(record.conversationId);
              if (current?.generation !== record.generation) return;
              const idleSince = blockers.length ? null : this.now();
              if (current.idleSince !== idleSince)
                this.store.upsert({ ...current, idleSince, generation: current.generation + 1 });
            });
            continue;
          }
          if (this.now() < record.idleSince + this.policy.idleMs) continue;
        }
        const preview = await this.preview(record.conversationId, signal);
        previews.push(preview);
        if (preview.action !== 'none') await this.confirm(preview.token, signal);
      } catch (error) {
        // One failed sandbox must not prevent independent conversations from
        // being reconciled. The failed record remains fenced for inspection.
        try {
          this.adapters.onReconcileError?.(record, error);
        } catch {
          // Observability must not defeat per-record isolation.
        }
      }
    }
    return previews;
  }
}

export function lifecyclePreviewDigest(
  preview: Pick<LifecyclePreview, 'record' | 'action' | 'expiresAt'>,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        preview.record.conversationId,
        preview.record.generation,
        preview.record.physicalSandboxId,
        preview.action,
        preview.expiresAt,
      ]),
    )
    .digest('hex');
}
