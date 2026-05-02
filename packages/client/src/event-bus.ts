/**
 * EventBus — SSE client for broadcast events.
 *
 * Wraps native EventSource to receive typed server-sent events (session state,
 * task updates, health, etc.). One instance per app, lives for the app's
 * lifetime. Complements the WebSocket (per-session, bidirectional) with a
 * global unidirectional awareness channel.
 *
 * EventSource auto-reconnects natively — no custom reconnect logic needed.
 * On reconnect, the server sends a fresh hydration snapshot.
 */

/** EventSource readyState constants — avoids referencing the global. */
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

  /**
   * Connect to the SSE endpoint. Call once on app mount.
   */
  connect(url: string): void {
    if (this.source) return;
    this.url = url;
    this.createSource();
  }

  /**
   * Subscribe to a specific event type. Returns an unsubscribe function.
   *
   * Listeners are tracked by the bus itself — they survive EventSource
   * reconnects because we re-register them on each new source.
   * The dispatch path goes through the listener set (not through
   * individual EventSource handlers), so unsubscribe is immediate.
   */
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

  /**
   * Register a callback for connection state changes.
   */
  onConnectionChange(cb: ConnectionChangeCallback): () => void {
    this.connectionChangeListeners.add(cb);
    return () => this.connectionChangeListeners.delete(cb);
  }

  /**
   * Ensure the SSE connection is alive. Call on app resume (iOS foreground).
   * If the EventSource is in CLOSED state (gave up reconnecting), recreates it.
   * No-op if still connected or reconnecting.
   */
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

  /**
   * Disconnect. Call on app unmount.
   */
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

  /**
   * Whether the SSE connection is currently open.
   */
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

    // Register one dispatch handler per event type on the new source.
    // Each handler fans out to all listeners in the set — no per-listener
    // handlers on the EventSource, so unsubscribe is just a Set.delete().
    for (const event of this.listeners.keys()) {
      this.registerEventDispatch(event);
    }
  }

  /**
   * Register a single EventSource handler for an event type that dispatches
   * to all listeners in the set. This indirection means unsubscribe doesn't
   * need to touch the EventSource — it just removes from the Set.
   */
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
