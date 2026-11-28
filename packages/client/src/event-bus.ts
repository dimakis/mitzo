// SSE client for broadcast events (session state, tasks, health).

// EventSource readyState constants.
const ES_OPEN = 1;
const ES_CLOSED = 2;

// Overlapping foreground signals (Capacitor resume + visibilitychange) arrive
// within a few hundred ms; keep the stream either of them just created.
export const RECREATE_DEBOUNCE_MS = 1000;

export type EventBusListener = (data: unknown) => void;
export type EventSourceFactory = (url: string) => EventSource;
export type EventSourceUrl = string | (() => string);
export type ConnectionChangeCallback = (connected: boolean) => void;

export interface EventBusOptions {
  factory?: EventSourceFactory;
  now?: () => number;
}

export class EventBus {
  private source: EventSource | null = null;
  private url: EventSourceUrl | null = null;
  private listeners = new Map<string, Set<EventBusListener>>();
  private connectionChangeListeners = new Set<ConnectionChangeCallback>();
  private createEventSource: EventSourceFactory;
  private now: () => number;
  private sourceCreatedAt = 0;

  constructor(factoryOrOptions?: EventSourceFactory | EventBusOptions) {
    const options =
      typeof factoryOrOptions === 'function' ? { factory: factoryOrOptions } : factoryOrOptions;
    this.createEventSource =
      options?.factory ?? ((url: string) => new EventSource(url, { withCredentials: true }));
    this.now = options?.now ?? Date.now;
  }

  connect(url: EventSourceUrl): void {
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

  /**
   * Reopen the stream now instead of waiting for the browser's native retry.
   *
   * A CLOSED or CONNECTING stream is recreated immediately: CONNECTING after a
   * foreground transition usually means WebKit is sitting in its built-in retry
   * delay (3 s per attempt, stacking when the network is still waking up).
   * `force` also recreates an OPEN stream, which is required after an app resume
   * because iOS can leave a suspended socket reporting OPEN while it is dead.
   * A stream created within RECREATE_DEBOUNCE_MS is kept so overlapping resume
   * and visibility signals do not churn connections.
   */
  ensureConnected(options: { force?: boolean } = {}): void {
    if (!this.url) return;
    const source = this.source;
    if (source && source.readyState !== ES_CLOSED) {
      const fresh = this.now() - this.sourceCreatedAt < RECREATE_DEBOUNCE_MS;
      if (fresh) return;
      if (source.readyState === ES_OPEN && !options.force) return;
    }
    this.closeSource();
    this.createSource();
  }

  disconnect(): void {
    this.closeSource();
  }

  get connected(): boolean {
    return this.source?.readyState === ES_OPEN;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private closeSource(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    source.onopen = null;
    source.onerror = null;
    source.close();
  }

  private createSource(): void {
    if (!this.url) return;

    const source = this.createEventSource(typeof this.url === 'function' ? this.url() : this.url);
    this.source = source;
    this.sourceCreatedAt = this.now();

    source.onopen = () => {
      if (this.source === source) this.notifyConnectionChange(true);
    };

    source.onerror = () => {
      if (this.source === source) this.notifyConnectionChange(false);
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
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch (error) {
        console.warn('[mitzo] EventBus dropped malformed event', { event, error: String(error) });
        return;
      }
      for (const listener of set) {
        try {
          listener(data);
        } catch (error) {
          console.warn('[mitzo] EventBus listener failed', { event, error: String(error) });
        }
      }
    }) as EventListener);
  }

  private notifyConnectionChange(connected: boolean): void {
    for (const cb of this.connectionChangeListeners) {
      try {
        cb(connected);
      } catch (error) {
        console.warn('[mitzo] EventBus connection listener failed', {
          connected,
          error: String(error),
        });
      }
    }
  }
}
