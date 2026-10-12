import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from './api-fetch';

export class SupersededListRequest extends Error {}

/** Memory-only snapshots: every mount revalidates, concurrent reads share work. */
export class ListCache<T> {
  private snapshots = new Map<string, T>();
  private pending = new Map<string, Promise<T>>();
  private generation = 0;

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
  }

  invalidate(): void {
    ++this.generation;
    this.pending.clear();
  }

  update(transform: (data: T) => T): void {
    this.invalidate();
    for (const [key, data] of this.snapshots) this.set(key, transform(data));
  }

  clear(): void {
    this.invalidate();
    this.snapshots.clear();
  }

  load(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const request = loader()
      .then((data) => {
        if (generation !== this.generation) throw new SupersededListRequest();
        this.set(key, data);
        return data;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
}
