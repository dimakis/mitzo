import {
  OrdinaryCommandDeliverySchema,
  parseLocalCommandDelivery,
  type OrdinaryCommandDelivery,
} from './local-command-delivery.js';
import {
  SourceSnapshotsSchema,
  LocalCodexFirstCommandReceiptSchema,
  OrdinaryCodexRetainedCommandObservationSchema,
} from '@mitzo/protocol';
/** Ordered, acknowledged HTTP delivery. SSE state never gates prompt submission. */
interface Entry {
  body: Record<string, unknown>;
  scope: number;
  uncertain?: boolean;
  localReceipt?: { sessionId: string; state: 'reserved' | 'uncertain' | 'consumed' };
  localDraftId?: string;
  ordinaryDelivery?: OrdinaryCommandDelivery;
}
interface Config {
  url: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  notify: (event: Record<string, unknown>) => void;
  headers?: () => Record<string, string>;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  timeoutMs?: number;
  requireDurableBriefings?: boolean;
  /** Independent launch commands survive tab replacement; never inherit another launch’s session. */
  durableLaunches?: boolean;
  /** Strict first-command route: durable intent, manual exact recovery, no legacy fallback. */
  localFirstCommand?: boolean;
}

export function hasReviewedSource(body: Record<string, unknown>): boolean {
  return (
    body.sessionId === null &&
    Array.isArray(body.sourceSnapshots) &&
    body.sourceSnapshots.length > 0 &&
    SourceSnapshotsSchema.safeParse(body.sourceSnapshots).success
  );
}

export class SendOutbox {
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
  private selectedLocalDraft: string | null | undefined;
  private localReady: Entry[] = [];
  private activeLocalEntry?: Entry;

  constructor(private config: Config) {
    this.key = `mitzo-send-outbox:${config.url}`;
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
                  'scope',
                  'uncertain',
                  'localReceipt',
                  'localDraftId',
                  'ordinaryDelivery',
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
            body,
            ...(ordinaryDelivery ? { ordinaryDelivery } : {}),
            uncertain: true,
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
    } catch {
      this.invalidLocalRecovery = !!config.localFirstCommand;
    }
  }

  start(): void {
    this.active = true;
    if (this.config.localFirstCommand) {
      if (this.invalidLocalRecovery)
        this.config.notify({ type: '_local_command_state', state: 'blocked' });
      else {
        const entry = this.selectedLocalEntry();
        if (entry) this.notifyLocal(entry, 'uncertain');
      }
      return;
    }
    void this.pump();
  }

  /** Verified connectivity supersedes offline backoff, never an in-flight
   * request or a guarded command's deliberate recovery decision. */
  wake(): void {
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

  private selectedLocalEntry(): Entry | undefined {
    return this.selectedLocalDraft === undefined
      ? this.entries[0]
      : this.selectedLocalDraft === null
        ? undefined
        : this.entries.find((entry) => entry.localDraftId === this.selectedLocalDraft);
  }

  /** Change the visible draft owner without discarding or dispatching another intent. */
  selectLocalDraft(draftId: string | null): void {
    if (!this.config.localFirstCommand || this.invalidLocalRecovery) return;
    this.selectedLocalDraft = draftId;
    const entry = this.selectedLocalEntry();
    if (entry)
      this.notifyLocal(
        entry,
        this.activeLocalEntry === entry || this.localReady.includes(entry)
          ? 'pending'
          : 'uncertain',
      );
    else this.config.notify({ type: '_local_command_state', state: 'idle', draftId });
  }

  /** Deliberate recovery resubmits only the frozen request, never a rebuilt draft. */
  retryLocalCommand(commandId?: string): boolean {
    if (
      !this.config.localFirstCommand ||
      !this.active ||
      this.invalidLocalRecovery ||
      !this.entries.length
    )
      return false;
    const entry = commandId
      ? this.entries.find((entry) => entry.body.clientMsgId === commandId)
      : this.selectedLocalEntry();
    if (!entry || this.activeLocalEntry === entry || this.localReady.includes(entry)) return false;
    this.localReady.push(entry);
    void this.pump();
    return true;
  }

  stop(): void {
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
  ): boolean {
    if (this.config.durableLaunches && body.sessionId !== null) return false;
    if (this.config.localFirstCommand) {
      if (localDraftId !== undefined && !/^\S{1,200}$/.test(localDraftId)) return false;
      if (
        this.invalidLocalRecovery ||
        !this.active ||
        this.entries.some(
          (entry) =>
            entry.body.clientMsgId === body.clientMsgId ||
            localDraftId === undefined ||
            entry.localDraftId === localDraftId,
        )
      )
        return false;
      try {
        body = structuredClone(parseLocalCommandDelivery(body, ordinaryDelivery));
        if (ordinaryDelivery)
          ordinaryDelivery = OrdinaryCommandDeliverySchema.parse(ordinaryDelivery);
      } catch {
        return false;
      }
    }
    if (ordinaryDelivery && !this.config.localFirstCommand) return false;
    if (this.entries.length >= 100) return false;
    const entry: Entry = {
      body: { ...body },
      scope,
      ...(this.config.localFirstCommand ? { uncertain: false } : {}),
      ...(this.config.localFirstCommand && localDraftId ? { localDraftId } : {}),
      ...(ordinaryDelivery ? { ordinaryDelivery: structuredClone(ordinaryDelivery) } : {}),
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
      return false;
    }
    if (this.config.localFirstCommand) {
      this.selectedLocalDraft = localDraftId;
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

  private notifyLocal(entry: Entry, state: string, acknowledged = false) {
    this.config.notify({
      type: '_local_command_state',
      state,
      ...(acknowledged ? { acknowledged: true } : {}),
      request: structuredClone(entry.body),
      ...(entry.ordinaryDelivery
        ? { ordinaryDelivery: structuredClone(entry.ordinaryDelivery) }
        : {}),
      clientMsgId: entry.body.clientMsgId,
      ...(entry.localDraftId ? { originDraftId: entry.localDraftId } : {}),
      ...(entry.localReceipt ? { sessionId: entry.localReceipt.sessionId } : {}),
    });
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
    try {
      entry.uncertain = true;
      if (!this.persist()) throw Error('Local intent could not be retained');
      const response = await Promise.race([
        this.config.fetch(
          entry.ordinaryDelivery?.version === 2
            ? '/api/ordinary/workspaces/commands/' + entry.ordinaryDelivery.phase
            : entry.body.runOn === 'openshell'
              ? typeof entry.body.sessionId === 'string'
                ? '/api/chat/runtime/continue'
                : '/api/chat/runtime/send'
              : typeof entry.body.sessionId === 'string'
                ? this.config.url.replace(/\/send$/, '/continue')
                : this.config.url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.config.headers?.() },
            body: JSON.stringify(entry.body),
            signal: abort.signal,
          },
        ),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(Error('Delivery interrupted')), {
            once: true,
          });
          timeout = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 15000);
        }),
      ]);
      const raw = await response.json();
      if (generation !== this.generation) return;
      const success = LocalCodexFirstCommandReceiptSchema.safeParse(raw);
      const observation = OrdinaryCodexRetainedCommandObservationSchema.safeParse(raw);
      const matching =
        raw?.clientMsgId === entry.body.clientMsgId &&
        (entry.ordinaryDelivery?.version !== 1 ||
          raw?.sessionId === entry.ordinaryDelivery.sessionId) &&
        (typeof entry.body.sessionId !== 'string' || raw?.sessionId === entry.body.sessionId);
      if (matching && response.status === 202 && success.success) {
        entry.localReceipt = { sessionId: success.data.sessionId, state: success.data.state };
        if (!this.persist()) throw Error('Local receipt could not be retained');
        this.notifyLocal(entry, success.data.state, true);
        if (success.data.state === 'consumed') this.entries.splice(this.entries.indexOf(entry), 1);
        this.persist();
      } else if (matching && response.status === 409 && observation.success) {
        entry.localReceipt = {
          sessionId: observation.data.sessionId,
          state: observation.data.state,
        };
        if (!this.persist()) throw Error('Local observation could not be retained');
        this.notifyLocal(entry, 'retained');
      } else this.notifyLocal(entry, 'uncertain');
    } catch {
      if (generation === this.generation) this.notifyLocal(entry, 'uncertain');
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
      if (!this.config.storage) return false;
      this.config.storage.setItem(this.key, JSON.stringify(this.entries));
      return true;
    } catch {
      // Ordinary sends retain their existing in-memory fallback.
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
        // A synchronous durable handoff must finish before dropping this exact command.
        // If it throws, replay the original clientMsgId/body for the same server receipt.
        this.config.notify({
          type: '_send_accepted',
          ...receipt,
          originalSessionId: entry.body.sessionId,
          ...(sourceHandoff ? { sourceHandoff } : {}),
        });
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
