import {
  LocalCodexFirstCommandSchema,
  LocalCodexFirstCommandReceiptSchema,
  LocalCodexRetainedCommandObservationSchema,
} from '@mitzo/protocol';
/** Ordered, acknowledged HTTP delivery. SSE state never gates prompt submission. */
interface Entry {
  body: Record<string, unknown>;
  scope: number;
  uncertain?: boolean;
  localReceipt?: { sessionId: string; state: 'reserved' | 'uncertain' | 'consumed' };
  localDraftId?: string;
}
interface Config {
  url: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  notify: (event: Record<string, unknown>) => void;
  headers?: () => Record<string, string>;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  timeoutMs?: number;
  requireDurableBriefings?: boolean;
  /** Strict first-command route: durable intent, manual exact recovery, no legacy fallback. */
  localFirstCommand?: boolean;
}

function reviewedBriefing(body: Record<string, unknown>): boolean {
  return (
    body.sessionId === null &&
    Array.isArray(body.sourceSnapshots) &&
    body.sourceSnapshots[0]?.kind === 'briefing'
  );
}

export class SendOutbox {
  private entries: Entry[] = [];
  private active = false;
  private busyGeneration: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private generation = 0;
  private activeAbort?: AbortController;
  private readonly key: string;
  private invalidLocalRecovery = false;

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
                !['body', 'scope', 'uncertain', 'localReceipt', 'localDraftId'].includes(key),
            )
          )
            throw Error('Invalid Local recovery');
          if (
            entry.localDraftId !== undefined &&
            (typeof entry.localDraftId !== 'string' || !/^\S{1,200}$/.test(entry.localDraftId))
          )
            throw Error('Invalid Local draft identity');
          const body = LocalCodexFirstCommandSchema.parse(entry.body);
          if (
            entry.localReceipt &&
            (!['reserved', 'uncertain', 'consumed'].includes(entry.localReceipt.state) ||
              typeof entry.localReceipt.sessionId !== 'string' ||
              !entry.localReceipt.sessionId.length ||
              entry.localReceipt.sessionId.length > 200 ||
              Object.keys(entry.localReceipt).length !== 2)
          )
            throw Error('Invalid Local receipt');
          return { ...entry, body, uncertain: true };
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
      else if (this.entries[0]) this.notifyLocal(this.entries[0], 'uncertain');
      return;
    }
    void this.pump();
  }

  /** Deliberate recovery resubmits only the frozen request, never a rebuilt draft. */
  retryLocalCommand(): boolean {
    if (
      !this.config.localFirstCommand ||
      !this.active ||
      this.invalidLocalRecovery ||
      !this.entries.length ||
      this.busyGeneration !== null
    )
      return false;
    void this.pump();
    return true;
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Pause new work; the bounded in-flight request may still acknowledge.
  }

  enqueue(body: Record<string, unknown>, scope: number, localDraftId?: string): boolean {
    if (this.config.localFirstCommand) {
      if (localDraftId !== undefined && !/^\S{1,200}$/.test(localDraftId)) return false;
      const parsed = LocalCodexFirstCommandSchema.safeParse(body);
      if (!parsed.success || this.invalidLocalRecovery || this.entries.length || !this.active)
        return false;
      body = structuredClone(parsed.data);
    }
    if (this.entries.length >= 100) return false;
    this.entries.push({
      body: { ...body },
      scope,
      ...(this.config.localFirstCommand ? { uncertain: false } : {}),
      ...(this.config.localFirstCommand && localDraftId ? { localDraftId } : {}),
    });
    const durable = this.persist();
    if (
      (this.config.localFirstCommand ||
        (this.config.requireDurableBriefings && reviewedBriefing(body))) &&
      !durable
    ) {
      this.entries.pop();
      return false;
    }
    if (this.config.localFirstCommand) this.notifyLocal(this.entries[0], 'pending');
    else
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
    const hadInFlight = this.busyGeneration !== null;
    this.busyGeneration = null;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rejected = this.entries.splice(0);
    this.entries = rejected.filter((entry, index) => {
      if (
        (!this.config.localFirstCommand && !reviewedBriefing(entry.body)) ||
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

  private notifyLocal(entry: Entry, state: string) {
    this.config.notify({
      type: '_local_command_state',
      state,
      request: structuredClone(entry.body),
      clientMsgId: entry.body.clientMsgId,
      ...(entry.localDraftId ? { originDraftId: entry.localDraftId } : {}),
      ...(entry.localReceipt ? { sessionId: entry.localReceipt.sessionId } : {}),
    });
  }

  private async pumpLocal(): Promise<void> {
    if (
      !this.active ||
      this.busyGeneration !== null ||
      !this.entries.length ||
      this.invalidLocalRecovery
    )
      return;
    const entry = this.entries[0];
    const generation = this.generation;
    const abort = new AbortController();
    this.busyGeneration = generation;
    this.activeAbort = abort;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      entry.uncertain = true;
      if (!this.persist()) throw Error('Local intent could not be retained');
      const response = await Promise.race([
        this.config.fetch(this.config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.config.headers?.() },
          body: JSON.stringify(entry.body),
          signal: abort.signal,
        }),
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
      const observation = LocalCodexRetainedCommandObservationSchema.safeParse(raw);
      const matching = raw?.clientMsgId === entry.body.clientMsgId;
      if (matching && response.status === 202 && success.success) {
        entry.localReceipt = { sessionId: success.data.sessionId, state: success.data.state };
        if (!this.persist()) throw Error('Local receipt could not be retained');
        this.notifyLocal(entry, success.data.state);
        if (success.data.state === 'consumed') this.entries.shift();
        this.persist();
        if (success.data.state === 'consumed' && this.entries[0])
          this.notifyLocal(this.entries[0], 'uncertain');
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
    try {
      if (reviewedBriefing(entry.body) && !entry.uncertain) {
        // Persist possible acceptance before admission, not only while fetch is
        // in flight. A lost response remains ambiguous during backoff/reload.
        entry.uncertain = true;
        if (!this.persist() && this.config.requireDurableBriefings) {
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
        if (entry.body.sessionId === null && receipt.sessionId) {
          for (const queued of this.entries) {
            if (
              queued.scope === entry.scope &&
              queued.body.sessionId === null &&
              !reviewedBriefing(queued.body)
            )
              queued.body.sessionId = receipt.sessionId;
          }
        }
      }
      this.failures = 0;
      this.persist();
    } catch {
      if (this.active && generation === this.generation) {
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
