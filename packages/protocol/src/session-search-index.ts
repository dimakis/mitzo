import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface SearchEvent {
  seq: number;
  session_id: string;
  type: string;
  payload: string;
  created_at: number;
}
export interface SearchSession {
  session_id: string;
  summary: string | null;
  updated_at: number;
}
export interface SearchHit extends SearchSession {
  payload: string;
  matched_at: number;
}

/** The worker owns only a disposable derived index, never a retained database
 * connection. The original database owner supplies bounded, append-only pages. */
export class SessionSearchIndex {
  private worker?: Worker;
  private directory?: string;
  private pending = new Map<
    number,
    { resolve(value: SearchHit[]): void; reject(error: Error): void }
  >();
  private nextId = 0;
  private cursor = 0;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private source: {
      highWater(): number;
      page(after: number, through: number): SearchEvent[];
      sessions(): SearchSession[];
    },
    private cacheDirectory?: string,
  ) {}

  private rpc(message: object): Promise<SearchHit[]> {
    if (this.closed) return Promise.reject(Error('Search owner closed'));
    if (!this.worker) {
      const source = import.meta.url.endsWith('.ts');
      let database = ':memory:';
      if (this.cacheDirectory) {
        if (!isAbsolute(this.cacheDirectory)) throw Error('Search cache root must be absolute');
        mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 });
        this.directory = mkdtempSync(join(this.cacheDirectory, 'search-'));
        database = join(this.directory, 'index.db');
        writeFileSync(database, '', { flag: 'wx', mode: 0o600 });
      }
      this.worker = new Worker(
        source
          ? `const {workerData}=require('node:worker_threads'); require(workerData.loader).register(); require(require('node:url').fileURLToPath(workerData.module));`
          : `const {workerData}=require('node:worker_threads'); import(workerData.module);`,
        {
          eval: true,
          workerData: {
            database,
            module: new URL(
              source ? './session-search-worker.ts' : './session-search-worker.js',
              import.meta.url,
            ).href,
            ...(source ? { loader: createRequire(import.meta.url).resolve('tsx/cjs/api') } : {}),
          },
        },
      );
      this.worker.on('message', (reply: { id: number; result?: SearchHit[]; failed?: boolean }) => {
        const pending = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (reply.failed) pending?.reject(Error('Search index unavailable'));
        else pending?.resolve(reply.result ?? []);
      });
      this.worker.on('error', () => this.close());
      this.worker.on('exit', () => this.close());
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...message, id });
    });
  }

  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
    const run = async () => {
      signal?.throwIfAborted();
      if (this.closed) throw Error('Search owner closed');
      const through = this.source.highWater();
      while (this.cursor < through) {
        signal?.throwIfAborted();
        const page = this.source.page(this.cursor, through);
        if (!page.length) break;
        await this.rpc({ type: 'append', events: page });
        this.cursor = page.at(-1)!.seq;
      }
      signal?.throwIfAborted();
      const result = await this.rpc({
        type: 'search',
        query,
        limit,
        sessions: this.source.sessions(),
      });
      signal?.throwIfAborted();
      return result;
    };
    // Only one index refresh/query at a time; rejected or cancelled readers do
    // not poison the queue, and an acknowledged page is never indexed twice.
    const result = this.tail.then(run);
    this.tail = result.catch(() => {});
    if (!signal) return result;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(Error('Search owner closed'));
    this.pending.clear();
    const directory = this.directory;
    // Remove only this newly-created disposable cache after its worker stops.
    const cleanup = () => {
      try {
        if (directory) rmSync(directory, { recursive: true, force: true });
      } catch {
        /* A disposable private cache never warrants unhandled rejection. */
      }
    };
    if (this.worker) void this.worker.terminate().then(cleanup, cleanup);
    else cleanup();
    this.worker = undefined;
  }
}
