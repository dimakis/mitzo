import {
  OrdinaryCommandDeliverySchema,
  ComposerDraftReceiptSchema,
  type ComposerDraftReceipt,
  parseLocalCommandDelivery,
  localCommandSessionId,
  type OrdinaryCommandDelivery,
} from './local-command-delivery.js';
import {
  ORDINARY_COMMAND_RECEIPT_TIMEOUT_MS,
  SourceSnapshotsSchema,
  LocalCodexFirstCommandReceiptSchema,
  OrdinaryCodexRetainedCommandObservationSchema,
  OrdinaryRuntimeEntryFailureSchema,
  RuntimeFailureSchema,
  type RuntimeFailure,
} from '@mitzo/protocol';
import {
  CommandDeliveryDiagnosticSchema,
  type CommandDeliveryDiagnostic,
  type CommandDeliveryObserver,
} from './command-delivery-diagnostic.js';
/** Ordered, acknowledged HTTP delivery. SSE state never gates prompt submission. */
export type SendOutboxStorage = Pick<Storage, 'getItem' | 'setItem'> & {
  flush?: () => Promise<void>;
  /** Reopen/hydrate device storage only; never dispatch or replace saved intent. */
  recover?: () => Promise<void>;
  subscribe?: (listener: () => void) => () => void;
};
interface Entry {
  body: Record<string, unknown>;
  scope: number;
  uncertain?: boolean;
  localReceipt?: { sessionId: string; state: 'reserved' | 'uncertain' | 'consumed' };
  localDraftId?: string;
  ordinaryDelivery?: OrdinaryCommandDelivery;
  composerDraft?: ComposerDraftReceipt;
  runtimeFailure?: RuntimeFailure;
  deliveryDiagnostic?: CommandDeliveryDiagnostic;
}
interface Config {
  url: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  notify: (event: Record<string, unknown>) => void;
  headers?: () => Record<string, string>;
  storage?: SendOutboxStorage;
  timeoutMs?: number;
  requireDurableBriefings?: boolean;
  /** Independent launch commands survive tab replacement; never inherit another launch’s session. */
  durableLaunches?: boolean;
  /** Strict first-command route: durable intent, manual exact recovery, no legacy fallback. */
  localFirstCommand?: boolean;
  onDeliveryDiagnostic?: CommandDeliveryObserver;
}

type DeliveryAttempt = Pick<
  CommandDeliveryDiagnostic,
  'operation' | 'stage' | 'httpStatus' | 'startedAt'
> & { timedOut?: boolean };

export function hasReviewedSource(body: Record<string, unknown>): boolean {
  return (
    body.sessionId === null &&
    Array.isArray(body.sourceSnapshots) &&
    body.sourceSnapshots.length > 0 &&
    SourceSnapshotsSchema.safeParse(body.sourceSnapshots).success
  );
}

export class SendOutbox {
  private enqueueFailure:
    'storage' | 'blocked' | 'inactive' | 'pending' | 'invalid' | 'full' | null = null;

  getEnqueueFailure() {
    return this.enqueueFailure;
  }

  private entries: Entry[] = [];
  private active = false;
  private busyGeneration: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private retryWakeable = false;
  private failures = 0;
  private generation = 0;
  private activeAbort?: AbortController;
  private readonly key: string;
  private invalidLocalRecovery = false;
  private selectedLocalScope: { draftId: string } | { sessionId: string } | null | undefined;
  private localReady: Entry[] = [];
  private activeLocalEntry?: Entry;
  private receiptReads = new Map<Entry, AbortController>();
  private receiptRechecks = new Set<Entry>();
  private completingLocal = new Map<Entry, number>();
  private localStates = new WeakMap<Entry, string>();
  private persistenceCause: unknown;
  private unsubscribeStorage?: () => void;
  private storageRecovery?: object;

  constructor(private config: Config) {
    this.key = `mitzo-send-outbox:${config.url}`;
    this.restore();
  }

  /** Re-read original durable intent after a failed read; never substitute an empty queue. */
  private restore(): boolean {
    const config = this.config;
    try {
      const saved: unknown = JSON.parse(config.storage?.getItem(this.key) ?? '[]');
      if (config.localFirstCommand) {
        if (!Array.isArray(saved) || saved.length > 100) throw Error('Invalid Local recovery');
        this.entries = saved.map((entry) => {
          if (
            !entry ||
            !Number.isSafeInteger(entry.scope) ||
            entry.scope < 0 ||
            typeof entry.uncertain !== 'boolean' ||
            Object.keys(entry).some(
              (key) =>
                ![
                  'body',
                  'runtimeFailure',
                  'deliveryDiagnostic',
                  'scope',
                  'uncertain',
                  'localReceipt',
                  'localDraftId',
                  'ordinaryDelivery',
                  'composerDraft',
                ].includes(key),
            )
          )
            throw Error('Invalid Local recovery');
          if (
            entry.localDraftId !== undefined &&
            (typeof entry.localDraftId !== 'string' || !/^\S{1,200}$/.test(entry.localDraftId))
          )
            throw Error('Invalid Local draft identity');
          const ordinaryDelivery =
            entry.ordinaryDelivery === undefined
              ? undefined
              : OrdinaryCommandDeliverySchema.parse(entry.ordinaryDelivery);
          const body = parseLocalCommandDelivery(entry.body, ordinaryDelivery);
          entry.deliveryDiagnostic = CommandDeliveryDiagnosticSchema.safeParse(
            entry.deliveryDiagnostic,
          ).data;
          if (
            entry.localReceipt &&
            (!['reserved', 'uncertain', 'consumed'].includes(entry.localReceipt.state) ||
              typeof entry.localReceipt.sessionId !== 'string' ||
              !entry.localReceipt.sessionId.length ||
              entry.localReceipt.sessionId.length > 200 ||
              ('sessionId' in body && entry.localReceipt.sessionId !== body.sessionId) ||
              (ordinaryDelivery?.version === 1 &&
                entry.localReceipt.sessionId !== ordinaryDelivery.sessionId) ||
              Object.keys(entry.localReceipt).length !== 2)
          )
            throw Error('Invalid Local receipt');
          return {
            ...entry,
            // Saved diagnostics are display hints only. Invalid future/device
            // values cannot invalidate or replace the original command.
            runtimeFailure: RuntimeFailureSchema.safeParse(entry.runtimeFailure).data,
            body,
            ...(ordinaryDelivery ? { ordinaryDelivery } : {}),
            ...(entry.composerDraft !== undefined
              ? { composerDraft: ComposerDraftReceiptSchema.parse(entry.composerDraft) }
              : {}),
            uncertain:
              entry.localReceipt?.state === 'consumed' && entry.uncertain === false ? false : true,
          };
        });
      } else if (Array.isArray(saved))
        this.entries = saved.filter(
          (entry): entry is Entry =>
            entry &&
            typeof entry.scope === 'number' &&
            entry.body?.type === 'send' &&
            typeof entry.body.clientMsgId === 'string' &&
            typeof entry.body.prompt === 'string',
        );
      this.invalidLocalRecovery = false;
      return true;
    } catch (cause) {
      if (config.localFirstCommand && !this.invalidLocalRecovery)
        console.warn('[mitzo] Saved command recovery unavailable', {
          stage: 'storage',
          code: 'local_recovery_unavailable',
          exceptionType: cause instanceof Error ? cause.name : 'Error',
        });
      this.invalidLocalRecovery = !!config.localFirstCommand;
      return false;
    }
  }

  start(): void {
    this.active = true;
    if (this.config.localFirstCommand) {
      this.unsubscribeStorage ??= this.config.storage?.subscribe?.(() => {
        if (this.active && this.invalidLocalRecovery) this.wake();
      });
      if (this.invalidLocalRecovery) this.restore();
      if (this.invalidLocalRecovery)
        this.config.notify({ type: '_local_command_state', state: 'blocked' });
      else {
        this.notifySelectedLocal();
        this.wake();
      }
      return;
    }
    void this.pump();
  }

  /** Verified connectivity supersedes offline backoff, never an in-flight
   * request or a guarded command's deliberate recovery decision. */
  wake(): void {
    if (this.config.localFirstCommand) {
      if (this.invalidLocalRecovery) {
        if (!this.active || !this.restore()) return;
        this.notifySelectedLocal();
      }
      // Connectivity and view selection permit observation only. They never
      // replay retained intent, including an already completed device action.
      const entry = this.selectedLocalScope ? this.selectedLocalEntry() : undefined;
      if (
        this.active &&
        entry &&
        this.activeLocalEntry !== entry &&
        !this.localReady.includes(entry)
      )
        void this.reconcileLocalCommand(String(entry.body.clientMsgId));
      return;
    }
    if (
      !this.active ||
      this.config.localFirstCommand ||
      this.busyGeneration !== null ||
      !this.retryWakeable ||
      !this.timer
    )
      return;
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.pump();
  }

  private localSession(entry: Entry): string | undefined {
    return localCommandSessionId(
      entry.body,
      entry.ordinaryDelivery?.version === 1
        ? entry.ordinaryDelivery.sessionId
        : entry.localReceipt?.sessionId,
    );
  }

  private selectedLocalEntry(): Entry | undefined {
    const scope = this.selectedLocalScope;
    return scope === undefined
      ? this.entries[0]
      : scope === null
        ? undefined
        : this.entries.find((entry) =>
            'draftId' in scope
              ? entry.localDraftId === scope.draftId
              : this.localSession(entry) === scope.sessionId,
          );
  }

  /** Change the visible owner without discarding or dispatching another intent. */
  selectLocalDraft(draftId: string | null): void {
    this.selectLocalScope(draftId === null ? null : { draftId });
  }

  selectLocalSession(sessionId: string): void {
    this.selectLocalScope({ sessionId });
  }

  private selectLocalScope(scope: typeof this.selectedLocalScope): void {
    if (!this.config.localFirstCommand) return;
    this.selectedLocalScope = scope;
    if (this.invalidLocalRecovery && !this.restore()) {
      this.config.notify({ type: '_local_command_state', state: 'blocked' });
      return;
    }
    this.notifySelectedLocal();
    this.wake();
  }

  private notifySelectedLocal(): void {
    const entry = this.selectedLocalEntry();
    if (entry)
      this.notifyLocal(
        entry,
        this.activeLocalEntry === entry || this.localReady.includes(entry)
          ? 'pending'
          : 'uncertain',
      );
    else this.config.notify({ type: '_local_command_state', state: 'idle' });
  }

  /** Deliberate recovery resubmits only the frozen request, never a rebuilt draft. */
  retryLocalCommand(commandId?: string): boolean {
    if (!this.config.localFirstCommand || !this.active) return false;
    if (this.invalidLocalRecovery) {
      if (this.storageRecovery) return false;
      const finish = () => {
        if (this.restore()) {
          this.notifySelectedLocal();
          this.wake();
        } else this.config.notify({ type: '_local_command_state', state: 'blocked' });
      };
      if (!this.config.storage?.recover) finish();
      else {
        const owner = (this.storageRecovery = {});
        void (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.config.storage!.recover!(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(Error('Storage recovery timed out')), 15_000);
              }),
            ]);
            // Storage notifications may already have recovered the queue. Never
            // overwrite newer in-memory delivery or revive a retired auth scope.
            if (this.active && this.storageRecovery === owner && this.invalidLocalRecovery)
              finish();
          } catch (cause) {
            if (this.active && this.storageRecovery === owner && this.invalidLocalRecovery) {
              console.warn('[mitzo] Saved command recovery unavailable', {
                stage: 'hydrate',
                code: 'local_recovery_unavailable',
                exceptionType: cause instanceof DOMException ? cause.name : 'Error',
              });
              this.config.notify({ type: '_local_command_state', state: 'blocked' });
            }
          } finally {
            if (timer) clearTimeout(timer);
            if (this.storageRecovery === owner) this.storageRecovery = undefined;
          }
        })();
      }
      // Recovering a previously unreadable queue is observation only. A separate
      // explicit retry may send the now-visible original command.
      return true;
    }
    if (!this.entries.length) return false;
    const entry = commandId
      ? this.entries.find((entry) => entry.body.clientMsgId === commandId)
      : this.selectedLocalEntry();
    if (!entry || this.activeLocalEntry === entry || this.localReady.includes(entry)) return false;
    if (entry.localReceipt?.state === 'consumed' && entry.uncertain === false) {
      // Admission is already proven. Retry only the retained source assignment.
      this.retireLocal(entry);
      return true;
    }
    this.localReady.push(entry);
    void this.pump();
    return true;
  }

  stop(): void {
    this.storageRecovery = undefined;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = undefined;
    for (const controller of this.receiptReads.values()) controller.abort();
    this.receiptReads.clear();
    this.receiptRechecks.clear();
    this.active = false;
    this.localReady = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Pause new work; the bounded in-flight request may still acknowledge.
  }

  enqueue(
    body: Record<string, unknown>,
    scope: number,
    localDraftId?: string,
    ordinaryDelivery?: OrdinaryCommandDelivery,
    composerDraft?: ComposerDraftReceipt,
  ): boolean {
    this.enqueueFailure = null;
    if (this.config.durableLaunches && body.sessionId !== null) return false;
    if (this.config.localFirstCommand) {
      if (localDraftId !== undefined && !/^\S{1,200}$/.test(localDraftId)) {
        this.enqueueFailure = 'invalid';
        return false;
      }
      const sessionId = localCommandSessionId(
        body,
        ordinaryDelivery?.version === 1 ? ordinaryDelivery.sessionId : undefined,
      );
      if (this.invalidLocalRecovery) this.restore();
      if (this.invalidLocalRecovery || !this.active) {
        this.enqueueFailure = this.invalidLocalRecovery ? 'blocked' : 'inactive';
        return false;
      }
      if (
        this.entries.some(
          (entry) =>
            entry.body.clientMsgId === body.clientMsgId ||
            (!localDraftId && !sessionId) ||
            (localDraftId !== undefined && entry.localDraftId === localDraftId) ||
            (sessionId !== undefined && this.localSession(entry) === sessionId),
        )
      ) {
        this.enqueueFailure = 'pending';
        return false;
      }
      try {
        body = structuredClone(parseLocalCommandDelivery(body, ordinaryDelivery));
        if (ordinaryDelivery)
          ordinaryDelivery = OrdinaryCommandDeliverySchema.parse(ordinaryDelivery);
        if (composerDraft) composerDraft = ComposerDraftReceiptSchema.parse(composerDraft);
      } catch {
        this.enqueueFailure = 'invalid';
        return false;
      }
    }
    if (ordinaryDelivery && !this.config.localFirstCommand) return false;
    if (this.entries.length >= 100) {
      this.enqueueFailure = 'full';
      return false;
    }
    const entry: Entry = {
      body: { ...body },
      scope,
      ...(this.config.localFirstCommand ? { uncertain: false } : {}),
      ...(this.config.localFirstCommand && localDraftId ? { localDraftId } : {}),
      ...(ordinaryDelivery ? { ordinaryDelivery: structuredClone(ordinaryDelivery) } : {}),
      ...(this.config.localFirstCommand && composerDraft
        ? { composerDraft: structuredClone(composerDraft) }
        : {}),
    };
    this.entries.push(entry);
    const durable = this.persist();
    if (
      (this.config.localFirstCommand ||
        this.config.durableLaunches ||
        (this.config.requireDurableBriefings && hasReviewedSource(body))) &&
      !durable
    ) {
      this.entries.pop();
      this.enqueueFailure = 'storage';
      return false;
    }
    if (this.config.localFirstCommand) {
      this.selectedLocalScope = localDraftId
        ? { draftId: localDraftId }
        : this.localSession(entry)
          ? { sessionId: this.localSession(entry)! }
          : undefined;
      this.localReady.push(entry);
      this.notifyLocal(entry, 'pending');
    } else
      this.config.notify({
        type: '_send_pending',
        clientMsgId: body.clientMsgId,
        sessionId: body.sessionId,
      });
    void this.pump();
    return true;
  }

  /** Reject queued prompts and surface an in-flight prompt as delivery-ambiguous. */
  rejectAll(error: string): void {
    this.storageRecovery = undefined;
    for (const controller of this.receiptReads.values()) controller.abort();
    this.receiptReads.clear();
    this.receiptRechecks.clear();
    this.active = false;
    this.generation++;
    this.localReady = [];
    this.activeLocalEntry = undefined;
    const hadInFlight = this.busyGeneration !== null;
    this.busyGeneration = null;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rejected = this.entries.splice(0);
    this.entries = rejected.filter((entry, index) => {
      if (this.config.localFirstCommand) {
        entry.uncertain = true;
        return true;
      }
      if (
        (!this.config.localFirstCommand &&
          !this.config.durableLaunches &&
          !hasReviewedSource(entry.body)) ||
        (!entry.uncertain && !(hadInFlight && index === 0))
      )
        return false;
      entry.uncertain = true;
      return true;
    });
    this.persist();
    for (const [index, entry] of rejected.entries()) {
      if (this.config.localFirstCommand) {
        this.notifyLocal(entry, 'uncertain');
        continue;
      }
      const deliveryUncertain = entry.uncertain || (hadInFlight && index === 0);
      this.config.notify({
        type: deliveryUncertain ? '_send_uncertain' : '_send_failed',
        clientMsgId: entry.body.clientMsgId,
        sessionId: entry.body.sessionId,
        error: deliveryUncertain
          ? 'Authentication changed while this message was being delivered. The server may have accepted it; check the conversation before sending it again.'
          : error,
      });
    }
  }

  private notifyLocal(
    entry: Entry,
    state: string,
    acknowledged = false,
    runtimeFailure: RuntimeFailure | undefined = entry.runtimeFailure,
  ) {
    this.localStates.set(entry, state);
    this.config.notify({
      type: '_local_command_state',
      state,
      ...(runtimeFailure ? { runtimeFailure } : {}),
      ...(entry.deliveryDiagnostic ? { deliveryDiagnostic: entry.deliveryDiagnostic } : {}),
      ...(entry.localReceipt?.state === 'consumed' ? { receiptConfirmed: true } : {}),
      ...(acknowledged ? { acknowledged: true } : {}),
      request: structuredClone(entry.body),
      ...(entry.composerDraft ? { composerDraft: structuredClone(entry.composerDraft) } : {}),
      ...(entry.ordinaryDelivery
        ? { ordinaryDelivery: structuredClone(entry.ordinaryDelivery) }
        : {}),
      clientMsgId: entry.body.clientMsgId,
      ...(entry.localDraftId ? { originDraftId: entry.localDraftId } : {}),
      ...(entry.localReceipt ? { sessionId: entry.localReceipt.sessionId } : {}),
    });
  }

  private deliveryFailure(
    entry: Entry,
    attempt: DeliveryAttempt,
    code?: CommandDeliveryDiagnostic['code'],
    cause?: unknown,
  ) {
    const diagnostic: CommandDeliveryDiagnostic = {
      operation: attempt.operation,
      stage: attempt.stage,
      startedAt: attempt.startedAt,
      elapsedMs: Math.max(0, Date.now() - attempt.startedAt),
      ...(attempt.httpStatus ? { httpStatus: attempt.httpStatus } : {}),
      code:
        code ??
        (attempt.timedOut
          ? attempt.stage === 'storage'
            ? 'storage_timeout'
            : 'timeout'
          : attempt.stage === 'storage'
            ? 'storage_failed'
            : attempt.stage === 'handoff'
              ? 'handoff_failed'
              : attempt.stage === 'response'
                ? 'invalid_receipt'
                : 'transport_failed'),
    };
    // A later pending observation must not erase the original submission failure.
    if (attempt.operation === 'submit' || entry.deliveryDiagnostic?.operation !== 'submit')
      entry.deliveryDiagnostic = diagnostic;
    if (!this.persist()) diagnostic.persistenceFailed = true;
    const event = {
      clientMsgId: String(entry.body.clientMsgId),
      ...(this.localSession(entry) ? { sessionId: this.localSession(entry) } : {}),
      diagnostic,
    };
    try {
      this.config.onDeliveryDiagnostic?.(event, cause);
    } catch {
      console.warn('[mitzo] Command delivery diagnostic observer failed', {
        clientMsgId: event.clientMsgId,
        code: 'diagnostic_observer_failed',
      });
    }
  }

  private async flushLocal(attempt: DeliveryAttempt): Promise<void> {
    if (!this.config.storage?.flush) return;
    const previousStage = attempt.stage;
    attempt.stage = 'storage';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.config.storage.flush(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            attempt.timedOut = true;
            reject(new Error('Local delivery storage deadline exceeded'));
          }, 15_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A failed flush keeps its failing stage for the caller's diagnostic.
    attempt.stage = previousStage;
  }

  /** A streamed/persisted reply is a hint to observe acceptance, never a grant
   * to resubmit intent. Only the server's exact consumed receipt clears input.
   */
  async reconcileLocalCommand(commandId: string): Promise<void> {
    const entry = this.entries.find((item) => item.body.clientMsgId === commandId);
    if (!this.active || !this.config.localFirstCommand || !entry) return;
    if (this.receiptReads.has(entry)) {
      // Later output may prove that an earlier pending observation is stale.
      // Coalesce hints into one follow-up read instead of dropping the final hint.
      this.receiptRechecks.add(entry);
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.receiptReads.set(entry, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let receiptConfirmed = false;
    const attempt: DeliveryAttempt = {
      operation: 'receipt',
      stage: 'request',
      startedAt: Date.now(),
    };
    try {
      const { response, raw } = await Promise.race([
        this.config
          .fetch(this.localUrl(entry) + '/receipt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.config.headers?.() },
            body: JSON.stringify(entry.body),
            signal: controller.signal,
          })
          .then(async (response) => {
            attempt.stage = 'response';
            attempt.httpStatus = response.status;
            return { response, raw: await response.json() };
          }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(Error('Receipt read interrupted')),
            { once: true },
          );
          timer = setTimeout(() => {
            attempt.timedOut = true;
            controller.abort();
          }, 15_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (generation !== this.generation || !this.active || !this.entries.includes(entry)) return;
      const receipt = LocalCodexFirstCommandReceiptSchema.safeParse(raw);
      if (
        response.status !== 202 ||
        !receipt.success ||
        receipt.data.state !== 'consumed' ||
        receipt.data.clientMsgId !== entry.body.clientMsgId ||
        (entry.ordinaryDelivery?.version === 1 &&
          receipt.data.sessionId !== entry.ordinaryDelivery.sessionId) ||
        (typeof entry.body.sessionId === 'string' &&
          receipt.data.sessionId !== entry.body.sessionId)
      ) {
        this.deliveryFailure(
          entry,
          attempt,
          response.status === 409 && raw?.code === 'receipt_pending'
            ? 'receipt_pending'
            : !response.ok
              ? 'http_rejected'
              : 'invalid_receipt',
        );
        if (this.activeLocalEntry !== entry && !this.localReady.includes(entry))
          this.notifyLocal(entry, this.localStates.get(entry) ?? 'uncertain');
        return;
      }
      receiptConfirmed = true;
      delete entry.runtimeFailure;
      delete entry.deliveryDiagnostic;
      entry.localReceipt = { sessionId: receipt.data.sessionId, state: 'consumed' };
      entry.uncertain = false;
      attempt.stage = 'storage';
      if (!this.persist()) {
        entry.uncertain = true;
        throw new Error('Local receipt could not be retained', { cause: this.persistenceCause });
      }
      if (this.config.storage?.flush) await this.flushLocal(attempt);
      if (generation !== this.generation || !this.active || !this.entries.includes(entry)) return;
      attempt.stage = 'handoff';
      await this.retireLocal(entry, true, attempt);
    } catch (cause) {
      // Read failures preserve the prior UI state. Once acceptance is proven,
      // completion storage failures must not restore an obsolete login reason.
      if (generation === this.generation && this.active && this.entries.includes(entry)) {
        this.deliveryFailure(
          entry,
          attempt,
          controller.signal.aborted && !attempt.timedOut ? 'cancelled' : undefined,
          cause,
        );
        if (receiptConfirmed || this.activeLocalEntry !== entry)
          this.notifyLocal(
            entry,
            receiptConfirmed ? 'uncertain' : (this.localStates.get(entry) ?? 'uncertain'),
          );
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.receiptReads.get(entry) === controller) {
        this.receiptReads.delete(entry);
        const recheck = this.receiptRechecks.delete(entry);
        if (
          recheck &&
          generation === this.generation &&
          this.active &&
          this.entries.includes(entry)
        )
          void this.reconcileLocalCommand(String(entry.body.clientMsgId));
      }
    }
  }
  private async retireLocal(
    entry: Entry,
    releaseTransport = false,
    attempt: DeliveryAttempt = { operation: 'receipt', stage: 'handoff', startedAt: Date.now() },
  ): Promise<void> {
    const generation = this.generation;
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.completingLocal.set(entry, index);
    this.entries.splice(index, 1);
    try {
      // Hide only this entry from reentrant UI callbacks, while retaining its
      // durable receipt until the source handoff has successfully committed.
      this.notifyLocal(entry, 'consumed', true);
      if (this.config.storage?.flush) await this.flushLocal(attempt);
      if (generation !== this.generation) {
        this.completingLocal.delete(entry);
        this.persist();
        return;
      }
      this.completingLocal.delete(entry);
      if (!this.persist())
        throw new Error('Local completion could not be retained', { cause: this.persistenceCause });
      if (this.config.storage?.flush) await this.flushLocal(attempt);
    } catch (cause) {
      this.completingLocal.delete(entry);
      if (!this.entries.includes(entry))
        this.entries.splice(Math.min(index, this.entries.length), 0, entry);
      this.deliveryFailure(entry, attempt, undefined, cause);
      this.notifyLocal(entry, 'uncertain');
      return;
    }
    const payload = entry.body.payload as
      { sourceSnapshots?: Array<{ kind?: string }> } | undefined;
    if (
      !entry.ordinaryDelivery &&
      !('sessionId' in entry.body) &&
      entry.localReceipt?.state === 'consumed' &&
      entry.uncertain === false &&
      payload?.sourceSnapshots?.[0]?.kind === 'briefing'
    ) {
      try {
        // Sensitive launch proof can retire only after the outbox removal is durable.
        this.config.notify({ type: '_local_command_retired', clientMsgId: entry.body.clientMsgId });
      } catch (cause) {
        // Cleanup failure is observable without resurrecting admitted work.
        this.deliveryFailure(
          entry,
          { operation: 'receipt', stage: 'cleanup', startedAt: Date.now() },
          'cleanup_failed',
          cause,
        );
      }
    }
    // Exact consumed acceptance releases only this original HTTP wait. Its
    // finally block can then admit the next explicit command immediately.
    if (releaseTransport && this.activeLocalEntry === entry) this.activeAbort?.abort();
  }
  private localUrl(entry: Entry): string {
    return entry.ordinaryDelivery?.version === 2
      ? '/api/ordinary/workspaces/commands/' + entry.ordinaryDelivery.phase
      : entry.body.runOn === 'openshell' ||
          (entry.body.runtime &&
            typeof entry.body.runtime === 'object' &&
            'harness' in entry.body.runtime &&
            ['claude-sdk', 'responses', 'gemini'].includes(String(entry.body.runtime.harness)))
        ? typeof entry.body.sessionId === 'string'
          ? '/api/chat/runtime/continue'
          : '/api/chat/runtime/send'
        : typeof entry.body.sessionId === 'string'
          ? this.config.url.replace(/\/send$/, '/continue')
          : this.config.url;
  }

  private async pumpLocal(): Promise<void> {
    if (
      !this.active ||
      this.busyGeneration !== null ||
      !this.localReady.length ||
      this.invalidLocalRecovery
    )
      return;
    const entry = this.localReady.shift()!;
    if (!this.entries.includes(entry)) return;
    this.activeLocalEntry = entry;
    const generation = this.generation;
    const abort = new AbortController();
    this.busyGeneration = generation;
    this.activeAbort = abort;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const attempt: DeliveryAttempt = {
      operation: 'submit',
      stage: 'storage',
      startedAt: Date.now(),
    };
    try {
      entry.uncertain = true;
      if (!this.persist())
        throw new Error('Local intent could not be retained', { cause: this.persistenceCause });
      if (this.config.storage?.flush) await this.flushLocal(attempt);
      if (
        generation !== this.generation ||
        !this.active ||
        abort.signal.aborted ||
        !this.entries.includes(entry)
      )
        return;
      attempt.stage = 'request';
      const { response, raw } = await Promise.race([
        this.config
          .fetch(this.localUrl(entry), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.config.headers?.() },
            body: JSON.stringify(entry.body),
            signal: abort.signal,
          })
          .then(async (response) => {
            attempt.stage = 'response';
            attempt.httpStatus = response.status;
            return { response, raw: await response.json() };
          }),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(Error('Delivery interrupted')), {
            once: true,
          });
          timeout = setTimeout(() => {
            attempt.timedOut = true;
            abort.abort();
          }, this.config.timeoutMs ?? ORDINARY_COMMAND_RECEIPT_TIMEOUT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      if (generation !== this.generation || !this.entries.includes(entry)) return;
      const success = LocalCodexFirstCommandReceiptSchema.safeParse(raw);
      const observation = OrdinaryCodexRetainedCommandObservationSchema.safeParse(raw);
      const matching =
        raw?.clientMsgId === entry.body.clientMsgId &&
        (entry.ordinaryDelivery?.version !== 1 ||
          raw?.sessionId === entry.ordinaryDelivery.sessionId) &&
        (typeof entry.body.sessionId !== 'string' || raw?.sessionId === entry.body.sessionId);
      if (matching && response.status === 202 && success.success) {
        delete entry.runtimeFailure;
        delete entry.deliveryDiagnostic;
        entry.localReceipt = { sessionId: success.data.sessionId, state: success.data.state };
        if (success.data.state === 'consumed') entry.uncertain = false;
        attempt.stage = 'storage';
        if (!this.persist()) {
          entry.uncertain = true;
          throw new Error('Local receipt could not be retained', { cause: this.persistenceCause });
        }
        if (this.config.storage?.flush) await this.flushLocal(attempt);
        if (generation !== this.generation || !this.active || !this.entries.includes(entry)) return;
        attempt.stage = 'handoff';
        if (success.data.state === 'consumed') await this.retireLocal(entry, false, attempt);
        else this.notifyLocal(entry, success.data.state, true);
        this.persist();
      } else if (matching && response.status === 409 && observation.success) {
        this.deliveryFailure(entry, attempt, 'runtime_failed');
        entry.runtimeFailure =
          'runtimeFailure' in observation.data ? observation.data.runtimeFailure : undefined;
        entry.localReceipt = {
          sessionId: observation.data.sessionId,
          state: observation.data.state,
        };
        attempt.stage = 'storage';
        if (!this.persist())
          throw new Error('Local observation could not be retained', {
            cause: this.persistenceCause,
          });
        if (this.config.storage?.flush) await this.flushLocal(attempt);
        attempt.stage = 'handoff';
        this.notifyLocal(
          entry,
          'retained',
          false,
          'runtimeFailure' in observation.data ? observation.data.runtimeFailure : undefined,
        );
      } else {
        const failure = OrdinaryRuntimeEntryFailureSchema.safeParse(raw);
        if (matching && response.status === 409 && failure.success) {
          entry.runtimeFailure = failure.data.runtimeFailure;
          attempt.stage = 'storage';
          if (!this.persist())
            throw new Error('Local diagnostic could not be retained', {
              cause: this.persistenceCause,
            });
          if (this.config.storage?.flush) await this.flushLocal(attempt);
          if (generation !== this.generation || !this.active || !this.entries.includes(entry))
            return;
        }
        this.deliveryFailure(
          entry,
          { ...attempt, stage: 'response' },
          !response.ok ? 'http_rejected' : 'invalid_receipt',
        );
        this.notifyLocal(entry, 'uncertain');
      }
    } catch (cause) {
      if (generation === this.generation && this.entries.includes(entry)) {
        this.deliveryFailure(
          entry,
          attempt,
          abort.signal.aborted && !attempt.timedOut ? 'cancelled' : undefined,
          cause,
        );
        this.notifyLocal(entry, 'uncertain');
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (generation === this.generation) {
        this.busyGeneration = null;
        this.activeAbort = undefined;
        this.activeLocalEntry = undefined;
        if (this.active && this.localReady.length) void this.pumpLocal();
      }
    }
  }

  private persist(): boolean {
    try {
      if (!this.config.storage || this.invalidLocalRecovery) return false;
      const retained = [...this.entries];
      for (const [entry, index] of this.completingLocal)
        if (!retained.includes(entry)) retained.splice(Math.min(index, retained.length), 0, entry);
      this.config.storage.setItem(this.key, JSON.stringify(retained));
      return true;
    } catch (cause) {
      // Ordinary sends retain their existing in-memory fallback.
      this.persistenceCause = cause;
      return false;
    }
  }

  private async pump(): Promise<void> {
    if (this.config.localFirstCommand) return this.pumpLocal();
    if (!this.active || this.busyGeneration !== null || this.timer || !this.entries.length) return;
    const entry = this.entries[0];
    const abort = new AbortController();
    const generation = this.generation;
    this.busyGeneration = generation;
    this.activeAbort = abort;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let receivedResponse = false;
    try {
      if ((this.config.durableLaunches || hasReviewedSource(entry.body)) && !entry.uncertain) {
        // Persist possible acceptance before admission, not only while fetch is
        // in flight. A lost response remains ambiguous during backoff/reload.
        entry.uncertain = true;
        if (
          !this.persist() &&
          (this.config.durableLaunches || this.config.requireDurableBriefings)
        ) {
          delete entry.uncertain;
          throw new Error('Reviewed attempt could not be retained');
        }
      }
      if (this.config.storage?.flush) await this.config.storage.flush();
      if (
        generation !== this.generation ||
        !this.active ||
        abort.signal.aborted ||
        !this.entries.includes(entry)
      )
        return;
      const { response, receipt } = await Promise.race([
        this.config
          .fetch(this.config.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.config.headers?.() },
            body: JSON.stringify(entry.body),
            signal: abort.signal,
          })
          .then(async (response) => {
            receivedResponse = true;
            if (response.status === 429 || response.status >= 500)
              throw new Error('Server temporarily unavailable');
            // A definitive HTTP rejection remains definitive even when an
            // intermediary supplies HTML. A malformed success is ambiguous:
            // retain its command ID and retry for the authoritative receipt.
            const receipt = response.ok
              ? await response.json()
              : await response.json().catch(() => null);
            return { response, receipt };
          }),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('Delivery interrupted')), {
            once: true,
          });
          timeout = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 15000);
        }),
      ]);
      if (generation !== this.generation) return;
      if (!response.ok) {
        this.entries.shift();
        this.config.notify({
          type: '_send_failed',
          clientMsgId: entry.body.clientMsgId,
          sessionId: entry.body.sessionId,
          error: receipt?.error ?? `Message was not accepted (HTTP ${response.status}).`,
        });
      } else {
        if (
          receipt.accepted !== true ||
          receipt.clientMsgId !== entry.body.clientMsgId ||
          (typeof receipt.sessionId !== 'string' && receipt.sessionId !== null)
        )
          throw new Error('Missing message acknowledgement');
        const source = Array.isArray(entry.body.sourceSnapshots)
          ? entry.body.sourceSnapshots[0]
          : null;
        const sourceHandoff =
          entry.body.sessionId === null && source?.kind === 'briefing'
            ? {
                clientMsgId: entry.body.clientMsgId,
                date: source.date,
                revision: source.revision,
                accountId: entry.body.accountId,
                model: entry.body.model,
                reasoningEffort: entry.body.reasoningEffort,
              }
            : entry.body.sessionId === null &&
                source?.kind === 'agent-library' &&
                hasReviewedSource(entry.body)
              ? { kind: 'agent-library', revision: source.revision }
              : undefined;
        // Handoff writes must commit before dropping this exact command.
        // If it throws, replay the original clientMsgId/body for the same server receipt.
        this.config.notify({
          type: '_send_accepted',
          ...receipt,
          originalSessionId: entry.body.sessionId,
          ...(sourceHandoff ? { sourceHandoff } : {}),
        });
        if (this.config.storage?.flush) await this.config.storage.flush();
        if (generation !== this.generation || !this.entries.includes(entry)) return;
        this.entries.shift();
        // Only unattempted follow-ups in the same draft inherit its session.
        if (!this.config.durableLaunches && entry.body.sessionId === null && receipt.sessionId) {
          for (const queued of this.entries) {
            if (
              queued.scope === entry.scope &&
              queued.body.sessionId === null &&
              !hasReviewedSource(queued.body)
            )
              queued.body.sessionId = receipt.sessionId;
          }
        }
      }
      this.failures = 0;
      this.persist();
    } catch {
      if (this.active && generation === this.generation) {
        // SSE connectivity cannot cure server backpressure, malformed receipts
        // or a failed durable handoff. Only pre-response transport loss wakes.
        this.retryWakeable = !receivedResponse;
        this.config.notify({
          type: '_send_pending',
          clientMsgId: entry.body.clientMsgId,
          sessionId: entry.body.sessionId,
          retrying: true,
        });
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            void this.pump();
          },
          Math.min(1000 * 2 ** this.failures++, 10000),
        );
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (timeout) clearTimeout(timeout);
      if (this.busyGeneration === generation) {
        this.busyGeneration = null;
        if (this.active && !this.timer) void this.pump();
      }
    }
  }
}
