import { createHash, randomUUID } from 'node:crypto';
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
  phase: 'Ready' | 'Stopped' | 'Error' | 'Pending' | 'Creating' | 'Starting';
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
  stop(record: OpenShellLifecycleRecord, signal: AbortSignal): Promise<void>;
  delete(record: OpenShellLifecycleRecord, signal: AbortSignal): Promise<void>;
  now?(): number;
  /** Explicit persisted operator consent. It is never inferred from an env var. */
  consent?(record: OpenShellLifecycleRecord): boolean;
}
export interface LifecyclePreview {
  token: string;
  expiresAt: number;
  record: OpenShellLifecycleRecord;
  action: 'stop' | 'delete' | 'none';
  blockers: LifecycleBlocker[];
}

function blockersFor(
  record: OpenShellLifecycleRecord,
  sandbox: LifecycleSandbox | undefined,
  protection: LifecycleProtection,
): LifecycleBlocker[] {
  const blockers = [...protection.blockers];
  if (!sandbox) blockers.push('inventory_unavailable');
  else if (
    sandbox.phase === 'Error' ||
    sandbox.phase === 'Pending' ||
    sandbox.phase === 'Creating' ||
    sandbox.phase === 'Starting'
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
      action: 'stop' | 'delete';
      expiresAt: number;
      used: boolean;
    }
  >();
  constructor(
    private store: OpenShellLifecycleStore,
    private policy: OpenShellLifecyclePolicy,
    private adapters: LifecycleAdapters,
  ) {}
  private now() {
    return this.adapters.now?.() ?? Date.now();
  }
  private prunePreviews() {
    const now = this.now();
    for (const [token, preview] of this.previews)
      if (preview.used || preview.expiresAt < now) this.previews.delete(token);
  }
  setRetentionConsent(conversationId: string, consent: boolean) {
    const record = this.store.get(conversationId);
    if (!record) throw new Error('OpenShell lifecycle conversation is unavailable');
    this.store.upsert({ ...record, generation: record.generation + 1, retentionConsent: consent });
  }
  /** Call exactly once during startup, before the reconciler accepts work. */
  recoverStartup() {
    this.store.reconcileInterrupted();
  }
  private async state(record: OpenShellLifecycleRecord, signal: AbortSignal) {
    const sandbox = await this.adapters.inspect(record, signal);
    const protection = await this.adapters.protect(record, signal);
    return { sandbox, blockers: blockersFor(record, sandbox, protection) };
  }
  async preview(conversationId: string, signal: AbortSignal): Promise<LifecyclePreview> {
    this.prunePreviews();
    const record = this.store.get(conversationId);
    if (!record) throw new Error('OpenShell lifecycle record not found');
    const { sandbox, blockers } = await this.state(record, signal);
    const action: LifecyclePreview['action'] =
      !this.policy.enabled || blockers.length
        ? 'none'
        : record.phase === 'retained' && sandbox?.phase === 'Ready'
          ? 'stop'
          : this.policy.retentionEligible(record, this.now())
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
        expiresAt,
        used: false,
      });
    return { token, expiresAt, record, action, blockers };
  }
  async confirm(token: string, signal: AbortSignal) {
    const preview = this.previews.get(token);
    if (!preview) throw new Error('OpenShell lifecycle preview is expired or already used');
    return sharedOpenShellLifecycleCoordinator.admit(preview.conversationId, () =>
      this.confirmLocked(token, signal),
    );
  }
  private async confirmLocked(token: string, signal: AbortSignal) {
    const preview = this.previews.get(token);
    if (!preview || preview.used || preview.expiresAt < this.now())
      throw new Error('OpenShell lifecycle preview is expired or already used');
    preview.used = true;
    const record = this.store.get(preview.conversationId);
    if (!record || record.generation !== preview.generation)
      throw new Error('OpenShell lifecycle preview is stale');
    const { sandbox, blockers } = await this.state(record, signal);
    if (!sandbox || sandbox.id !== preview.sandboxId || blockers.length)
      throw new Error('OpenShell lifecycle preservation check failed');
    if (preview.action === 'stop') {
      if (sandbox.phase !== 'Ready') throw new Error('OpenShell lifecycle preview is stale');
      const checkpointing = this.store.transition(
        record.conversationId,
        record.generation,
        'checkpointing',
      );
      if (!checkpointing) throw new Error('OpenShell lifecycle generation changed');
      let checkpoint: OpenShellLifecycleRecord['checkpoint'];
      try {
        checkpoint = (await this.adapters.checkpoint?.(checkpointing, sandbox, signal)) ?? null;
      } catch (error) {
        this.store.upsert({
          ...checkpointing,
          phase: 'failed',
          generation: checkpointing.generation + 1,
          failure: error instanceof Error ? error.message : 'checkpoint failed',
        });
        throw error;
      }
      const checkpointed = checkpoint
        ? this.store.saveCheckpoint(checkpointing.conversationId, checkpointing.generation, {
            ...checkpoint,
            sourceResourceVersion: sandbox.resourceVersion,
          })
        : null;
      if (!checkpointed || !(await this.adapters.verifyCheckpoint?.(checkpointed, sandbox, signal)))
        throw new Error('OpenShell checkpoint is unavailable');
      const afterCheckpoint = await this.state(checkpointed, signal);
      if (
        !afterCheckpoint.sandbox ||
        afterCheckpoint.sandbox.id !== sandbox.id ||
        afterCheckpoint.blockers.length
      )
        throw new Error('OpenShell state changed while checkpointing');
      const stopping = this.store.transition(
        record.conversationId,
        checkpointed.generation,
        'stopping',
      );
      if (!stopping) throw new Error('OpenShell lifecycle generation changed');
      await this.adapters.stop({ ...stopping, checkpoint }, signal);
      const stopped = await this.adapters.inspect(stopping, signal);
      if (
        !stopped ||
        stopped.id !== stopping.physicalSandboxId ||
        stopped.phase !== 'Stopped' ||
        !stopped.resourceVersion
      )
        throw new Error('OpenShell stop could not be verified');
      this.store.upsert({
        ...stopping,
        phase: 'stopped',
        generation: stopping.generation + 1,
        checkpoint: checkpointed.checkpoint,
        stoppedAt: this.now(),
        idleSince: stopping.idleSince ?? this.now(),
        stoppedResourceVersion: stopped.resourceVersion,
      });
      return 'stopped';
    }
    if (
      sandbox.phase !== 'Stopped' ||
      !this.policy.retentionEligible(record, this.now()) ||
      !record.checkpoint ||
      !(await this.adapters.verifyCheckpoint?.(record, sandbox, signal))
    )
      throw new Error('OpenShell lifecycle preview is stale');
    const beforeDelete = await this.state(record, signal);
    if (
      !beforeDelete.sandbox ||
      beforeDelete.sandbox.id !== preview.sandboxId ||
      beforeDelete.blockers.length
    )
      throw new Error('OpenShell lifecycle preservation check failed');
    const deleting = this.store.transition(record.conversationId, record.generation, 'deleting');
    if (!deleting) throw new Error('OpenShell lifecycle generation changed');
    await this.adapters.delete(deleting, signal);
    this.store.upsert({ ...deleting, phase: 'deleted', generation: deleting.generation + 1 });
    return 'deleted';
  }
  async reconcile(signal: AbortSignal) {
    if (!this.policy.enabled) return [] as LifecyclePreview[];
    const previews: LifecyclePreview[] = [];
    for (const record of this.store.list()) {
      if (record.phase !== 'retained' && record.phase !== 'stopped') continue;
      if (!this.adapters.consent?.(record)) continue;
      if (
        record.phase === 'retained' &&
        (!record.idleSince || this.now() < record.idleSince + this.policy.idleMs)
      )
        continue;
      try {
        const preview = await this.preview(record.conversationId, signal);
        previews.push(preview);
        if (preview.action !== 'none') await this.confirm(preview.token, signal);
      } catch {
        // One failed sandbox must not prevent independent conversations from
        // being reconciled. The failed record remains fenced for inspection.
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
