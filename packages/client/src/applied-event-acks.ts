interface AckSession {
  pending: number[];
  highestQueued: number;
  supersededThrough: number;
  scheduled: boolean;
  running: boolean;
  inFlightCount: number;
}

/** Exact sequence batches preserve server predecessor validation; no cumulative skips. */
export class AppliedEventAcks {
  private sessions = new Map<string, AckSession>();
  private outstanding = 0;
  private generation = 0;
  constructor(
    private readonly options: {
      post(sessionId: string, sequences: number[]): Promise<boolean>;
      resync(): void;
    },
  ) {}

  reset(): void {
    this.generation++;
    this.sessions.clear();
    this.outstanding = 0;
  }

  clearSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) this.outstanding -= state.pending.length + state.inFlightCount;
    this.sessions.delete(sessionId);
  }

  supersede(sessionId: string, cursor: number): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.supersededThrough = Math.max(state.supersededThrough, cursor);
    state.highestQueued = Math.max(state.highestQueued, cursor);
    const retained = state.pending.filter((seq) => seq > cursor);
    this.outstanding -= state.pending.length - retained.length;
    state.pending = retained;
  }

  enqueue(sessionId: string, seq: number): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        pending: [],
        highestQueued: 0,
        supersededThrough: 0,
        scheduled: false,
        running: false,
        inFlightCount: 0,
      };
      this.sessions.set(sessionId, state);
    }
    if (seq <= state.highestQueued) return;
    if (this.outstanding >= 500) {
      this.reset();
      this.options.resync();
      return;
    }
    state.pending.push(seq);
    state.highestQueued = seq;
    this.outstanding++;
    if (state.running || state.scheduled) return;
    state.scheduled = true;
    const generation = this.generation;
    void Promise.resolve().then(() => this.flush(sessionId, state, generation));
  }

  private async flush(sessionId: string, state: AckSession, generation: number): Promise<void> {
    const current = () => this.generation === generation && this.sessions.get(sessionId) === state;
    if (!current()) return;
    state.scheduled = false;
    state.running = true;
    while (current() && state.pending.length) {
      const sequences = state.pending.splice(0, 50);
      state.inFlightCount = sequences.length;
      let applied = false;
      try {
        applied = await this.options.post(sessionId, sequences);
      } catch {
        /* recover below */
      }
      if (!current()) return;
      this.outstanding -= sequences.length;
      state.inFlightCount = 0;
      if (!applied && sequences[sequences.length - 1] > state.supersededThrough) {
        this.reset();
        this.options.resync();
        return;
      }
    }
    state.running = false;
  }
}
