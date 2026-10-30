import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from './api-fetch';

export class SupersededListRequest extends Error {}

/** Memory-only snapshots: every mount revalidates, concurrent reads share work. */
export class ListCache<T> {
  private snapshots = new Map<string, T>();
  private pending = new Map<string, Promise<T>>();
  private listeners = new Map<string, Set<() => void>>();
  private generation = 0;
  private admissions = new Map<string, Promise<T>>();
  private resolving = new Map<string, { request: Promise<T>; ids: Set<string> }>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener(AUTH_LOST_EVENT, () => this.clear());
      window.addEventListener(AUTH_RESTORED_EVENT, () => this.clear());
    }
  }

  get(key: string): T | undefined {
    return this.snapshots.get(key);
  }

  set(key: string, data: T): void {
    this.snapshots.set(key, data);
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  invalidate(): void {
    ++this.generation;
    this.pending.clear();
    this.resolving.clear();
    this.admissions.clear();
  }

  update(transform: (data: T) => T): void {
    this.invalidate();
    for (const [key, data] of this.snapshots) this.set(key, transform(data));
  }

  clear(): void {
    this.invalidate();
    this.snapshots.clear();
    this.listeners.forEach((listeners) => listeners.forEach((listener) => listener()));
  }

  load(
    key: string,
    loader: () => Promise<T>,
    onAccepted?: (data: T) => void,
    resolution?: { id: string; present(snapshot: T | undefined): boolean; retire(): void },
  ): Promise<T> {
    const existing = this.pending.get(key);
    const peers = this.resolving.get(key);
    const missing = resolution && !resolution.present(this.snapshots.get(key));
    if (existing && (!missing || (peers?.request === existing && peers.ids.has(resolution.id))))
      return existing;
    // A newly selected missing identity must not join a pre-save read. Retire
    // that admission once, carrying peers into its successor so their retries
    // share the newer read rather than repeatedly superseding each other.
    const ids = new Set(peers?.request === existing ? peers?.ids : []);
    if (missing) ids.add(resolution.id);
    if (existing) {
      this.pending.delete(key);
      resolution?.retire();
    }
    const generation = this.generation;
    const request: Promise<T> = loader()
      .then((data) => {
        if (generation !== this.generation) throw new SupersededListRequest();
        const successor = this.admissions.get(key);
        if (successor && successor !== request) return successor;
        // Record derived memory only at admission, before observers or later
        // mutations can run. Superseded responses never reach this callback.
        onAccepted?.(data);
        this.set(key, data);
        return data;
      })
      .catch((error: unknown) => {
        const successor = this.admissions.get(key);
        if (generation === this.generation && successor && successor !== request) return successor;
        throw error;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
        if (this.resolving.get(key)?.request === request) this.resolving.delete(key);
      });
    this.pending.set(key, request);
    this.admissions.set(key, request);
    if (ids.size) this.resolving.set(key, { request, ids });
    return request;
  }
}
