/** Orders durable session events before advancing the client reconnect cursor. */
export interface AppliedDeliveryOptions {
  getCursor(sessionId: string): number;
  setCursor(sessionId: string, seq: number): void;
  deliver(event: Record<string, unknown>): boolean | void;
  ackEvent(sessionId: string, seq: number): void;
  ackSnapshot(sessionId: string, cursor: number, offerId: string): void;
  resync(sessionId: string): void;
}

interface PendingSession {
  events: Map<number, Record<string, unknown>>;
  bytes: number;
  gapTimer?: ReturnType<typeof setTimeout>;
  waitingForSnapshot?: boolean;
  resyncRequested?: boolean;
  offer?: { cursor: number; offerId: string; connectionId: string };
}

const MAX_BUFFERED_EVENTS = 256;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_GAP_WAIT_MS = 15_000;
const MAX_SNAPSHOT_WAIT_MS = 30_000;

export class AppliedDelivery {
  private sessions = new Map<string, PendingSession>();
  private deliver: AppliedDeliveryOptions['deliver'];

  constructor(private readonly options: AppliedDeliveryOptions) {
    this.deliver = options.deliver;
  }

  setDeliver(deliver: AppliedDeliveryOptions['deliver']): void {
    this.deliver = deliver;
  }

  clearSession(sessionId: string): void {
    this.clearGapTimer(this.sessions.get(sessionId));
    this.sessions.delete(sessionId);
  }

  clearPending(): void {
    for (const state of this.sessions.values()) this.clearGapTimer(state);
    this.sessions.clear();
  }

  holdReplay(sessionId: string): void {
    const state = this.state(sessionId);
    this.clearGapTimer(state);
    state.waitingForSnapshot = true;
    this.armGapTimer(sessionId, state);
  }

  releaseReplay(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.waitingForSnapshot = false;
    this.clearGapTimer(state);
    this.drain(sessionId, state);
  }

  /** Commit a REST transcript only after its state has been installed. */
  commitTranscript(sessionId: string, cursor: number): void {
    const state = this.state(sessionId);
    if (state.offer || state.waitingForSnapshot) return;
    const committed = Math.max(cursor, this.options.getCursor(sessionId));
    for (const [seq, event] of state.events) {
      if (seq > committed) continue;
      state.events.delete(seq);
      state.bytes -= JSON.stringify(event).length;
    }
    this.options.setCursor(sessionId, committed);
    if (committed > 0) this.options.ackEvent(sessionId, committed);
    this.clearGapTimer(state);
    this.drain(sessionId, state);
  }

  offerSnapshot(sessionId: string, cursor: number, offerId: string, connectionId: string): void {
    const state = this.state(sessionId);
    this.clearGapTimer(state);
    state.waitingForSnapshot = false;
    state.resyncRequested = false;
    state.offer = { cursor, offerId, connectionId };
    this.armGapTimer(sessionId, state);
  }

  acknowledgeSnapshot(
    sessionId: string,
    cursor: number,
    offerId: string,
    connectionId: string,
  ): boolean {
    const state = this.sessions.get(sessionId);
    const offer = state?.offer;
    if (
      !state ||
      !offer ||
      offer.cursor !== cursor ||
      offer.offerId !== offerId ||
      offer.connectionId !== connectionId
    )
      return false;
    state.offer = undefined;
    this.clearGapTimer(state);
    for (const [seq, event] of state.events) {
      if (seq > cursor) continue;
      state.events.delete(seq);
      state.bytes -= JSON.stringify(event).length;
    }
    this.options.setCursor(sessionId, cursor);
    this.options.ackSnapshot(sessionId, cursor, offerId);
    this.drain(sessionId, state);
    return true;
  }

  /** Returns false only when this is not a chained durable event. */
  receive(event: Record<string, unknown>): boolean {
    const sessionId = event.sessionId;
    const seq = event.seq;
    const prev = event.prevSessionSeq;
    if (
      typeof sessionId !== 'string' ||
      !Number.isSafeInteger(seq) ||
      !Number.isSafeInteger(prev) ||
      (seq as number) <= 0 ||
      (prev as number) < 0
    )
      return false;
    const state = this.state(sessionId);
    if ((seq as number) <= this.options.getCursor(sessionId)) {
      // The server may have retried because the previous acknowledgement was
      // lost. Reassert application without dispatching the duplicate again.
      this.options.ackEvent(sessionId, seq as number);
      return true;
    }
    if (state.offer || state.waitingForSnapshot || prev !== this.options.getCursor(sessionId)) {
      this.buffer(sessionId, state, event);
      return true;
    }
    if (this.apply(sessionId, state, event)) this.drain(sessionId, state);
    else this.buffer(sessionId, state, event);
    return true;
  }

  private state(sessionId: string): PendingSession {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { events: new Map(), bytes: 0 };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private apply(sessionId: string, state: PendingSession, event: Record<string, unknown>): boolean {
    try {
      const applied = this.deliver(event);
      if (applied !== true) {
        if (applied === false) this.requestResync(sessionId, state);
        return false;
      }
    } catch {
      this.requestResync(sessionId, state);
      return false;
    }
    const seq = event.seq as number;
    const buffered = state.events.get(seq);
    if (buffered) {
      state.events.delete(seq);
      state.bytes -= JSON.stringify(buffered).length;
    }
    if (state.events.size === 0) this.clearGapTimer(state);
    this.options.setCursor(sessionId, seq);
    this.options.ackEvent(sessionId, seq);
    return true;
  }

  private requestResync(sessionId: string, state: PendingSession): void {
    if (state.resyncRequested) return;
    state.resyncRequested = true;
    this.clearGapTimer(state);
    this.options.resync(sessionId);
  }

  private clearGapTimer(state?: PendingSession): void {
    if (!state?.gapTimer) return;
    clearTimeout(state.gapTimer);
    state.gapTimer = undefined;
  }

  private armGapTimer(sessionId: string, state: PendingSession): void {
    if (
      state.gapTimer ||
      state.resyncRequested ||
      (!state.offer && !state.waitingForSnapshot && state.events.size === 0)
    )
      return;
    const waitingForSnapshot = !!state.offer || !!state.waitingForSnapshot;
    state.gapTimer = setTimeout(
      () => {
        state.gapTimer = undefined;
        if (
          this.sessions.get(sessionId) === state &&
          (state.events.size > 0 || state.offer || state.waitingForSnapshot)
        )
          this.requestResync(sessionId, state);
      },
      waitingForSnapshot ? MAX_SNAPSHOT_WAIT_MS : MAX_GAP_WAIT_MS,
    );
  }

  private drain(sessionId: string, state: PendingSession): void {
    while (!state.offer && !state.waitingForSnapshot) {
      const cursor = this.options.getCursor(sessionId);
      const next = [...state.events.values()].find((event) => event.prevSessionSeq === cursor);
      if (!next || !this.apply(sessionId, state, next)) break;
    }
    if (state.events.size === 0) this.clearGapTimer(state);
    else this.armGapTimer(sessionId, state);
  }

  private buffer(sessionId: string, state: PendingSession, event: Record<string, unknown>): void {
    const seq = event.seq as number;
    if (state.events.has(seq)) return;
    state.events.set(seq, event);
    state.bytes += JSON.stringify(event).length;
    if (state.events.size > MAX_BUFFERED_EVENTS || state.bytes > MAX_BUFFERED_BYTES) {
      this.clearGapTimer(state);
      this.sessions.delete(sessionId);
      this.options.resync(sessionId);
    } else this.armGapTimer(sessionId, state);
  }
}
