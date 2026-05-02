// SSE client for broadcast events (session state, tasks, health).

// EventSource readyState constants.
const ES_OPEN = 1;
const ES_CLOSED = 2;

export type EventBusListener = (data: unknown) => void;
export type EventSourceFactory = (url: string) => EventSource;
export type ConnectionChangeCallback = (connected: boolean) => void;

export class EventBus {
  private source: EventSource | null = null;
  private url: string | null = null;
  private listeners = new Map<string, Set<EventBusListener>>();
  private connectionChangeListeners = new Set<ConnectionChangeCallback>();
  private createEventSource: EventSourceFactory;

  constructor(factory?: EventSourceFactory) {
    this.createEventSource =
      factory ?? ((url: string) => new EventSource(url, { withCredentials: true }));
  }

  connect(url: string): void {
    if (this.source) return;
    this.url = url;
    this.createSource();
  }

  // Listeners survive EventSource reconnects — dispatch goes through the Set.
  on(event: string, listener: EventBusListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
      // First listener for this event type — register the dispatch handler
      if (this.source) {
        this.registerEventDispatch(event);
      }
    }
    set.add(listener);

    return () => {
      set!.delete(listener);
    };
  }

  onConnectionChange(cb: ConnectionChangeCallback): () => void {
    this.connectionChangeListeners.add(cb);
    return () => this.connectionChangeListeners.delete(cb);
  }

  // Recreate EventSource if CLOSED (gave up). No-op if still alive.
  ensureConnected(): void {
    if (!this.url) return;
    if (!this.source || this.source.readyState === ES_CLOSED) {
      if (this.source) {
        try {
          this.source.close();
        } catch {
          /* best effort */
        }
      }
      this.source = null;
      this.createSource();
    }
  }

  disconnect(): void {
    if (this.source) {
      try {
        this.source.close();
      } catch {
        /* best effort */
      }
      this.source = null;
    }
  }

  get connected(): boolean {
    return this.source?.readyState === ES_OPEN;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private createSource(): void {
    if (!this.url) return;

    const source = this.createEventSource(this.url);
    this.source = source;

    source.onopen = () => {
      this.notifyConnectionChange(true);
    };

    source.onerror = () => {
      this.notifyConnectionChange(false);
    };

    for (const [event, set] of this.listeners) {
      if (set.size > 0) this.registerEventDispatch(event);
    }
  }

  private registerEventDispatch(event: string): void {
    if (!this.source) return;
    this.source.addEventListener(event, ((e: MessageEvent) => {
      const set = this.listeners.get(event);
      if (!set || set.size === 0) return;
      try {
        const data = JSON.parse(e.data);
        for (const listener of set) {
          listener(data);
        }
      } catch {
        // Malformed JSON — skip
      }
    }) as EventListener);
  }

  private notifyConnectionChange(connected: boolean): void {
    for (const cb of this.connectionChangeListeners) {
      try {
        cb(connected);
      } catch {
        /* listener error — don't propagate */
      }
    }
  }
}
