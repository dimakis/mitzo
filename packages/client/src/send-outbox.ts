/** Ordered, acknowledged HTTP delivery. SSE state never gates prompt submission. */
interface Entry {
  body: Record<string, unknown>;
  scope: number;
}
interface Config {
  url: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  notify: (event: Record<string, unknown>) => void;
  headers?: () => Record<string, string>;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  timeoutMs?: number;
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

  constructor(private config: Config) {
    this.key = `mitzo-send-outbox:${config.url}`;
    try {
      const saved: unknown = JSON.parse(config.storage?.getItem(this.key) ?? '[]');
      if (Array.isArray(saved))
        this.entries = saved.filter(
          (entry): entry is Entry =>
            entry &&
            typeof entry.scope === 'number' &&
            entry.body?.type === 'send' &&
            typeof entry.body.clientMsgId === 'string' &&
            typeof entry.body.prompt === 'string',
        );
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
  }

  start(): void {
    this.active = true;
    void this.pump();
  }
  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Pause new work; the bounded in-flight request may still acknowledge.
  }

  enqueue(body: Record<string, unknown>, scope: number): boolean {
    if (this.entries.length >= 100) return false;
    this.entries.push({ body: { ...body }, scope });
    this.persist();
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
    this.persist();
    for (const [index, entry] of rejected.entries()) {
      const deliveryUncertain = hadInFlight && index === 0;
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

  private persist(): void {
    try {
      this.config.storage?.setItem(this.key, JSON.stringify(this.entries));
    } catch {
      /* In-memory retries still work if storage is full/disabled. */
    }
  }

  private async pump(): Promise<void> {
    if (!this.active || this.busyGeneration !== null || this.timer || !this.entries.length) return;
    const entry = this.entries[0];
    const abort = new AbortController();
    const generation = this.generation;
    this.busyGeneration = generation;
    this.activeAbort = abort;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
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
        this.entries.shift();
        // Only unattempted follow-ups in the same draft inherit its session.
        if (entry.body.sessionId === null && receipt.sessionId) {
          for (const queued of this.entries) {
            if (queued.scope === entry.scope && queued.body.sessionId === null)
              queued.body.sessionId = receipt.sessionId;
          }
        }
        this.config.notify({
          type: '_send_accepted',
          ...receipt,
          originalSessionId: entry.body.sessionId,
        });
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
