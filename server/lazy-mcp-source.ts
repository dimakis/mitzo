import { createLogger } from './logger.js';

/** One session owns a source. Concurrent callers share initialization, not authorization.
 * A failed/cancelled initialization is retained; it is never silently retried. */
export class LazyMcpSource<T extends { close(): Promise<void> }> {
  private pending?: Promise<T>;
  private peer?: T;
  private waiters = 0;
  private settled = false;
  private controller = new AbortController();
  private closing?: Promise<void>;
  constructor(
    private sourceId: string,
    private connect: (signal: AbortSignal) => Promise<T>,
  ) {}
  async get(signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    this.controller.signal.throwIfAborted();
    this.waiters++;
    if (!this.pending) {
      this.pending = this.connect(this.controller.signal)
        .then(async (peer) => {
          this.peer = peer;
          if (this.controller.signal.aborted) {
            await peer.close();
            this.controller.signal.throwIfAborted();
          }
          return peer;
        })
        .catch((error) => {
          const log = createLogger('configured-mcp');
          const fields = {
            code: 'mcp_initialization_failed',
            stage: 'initialize',
            sourceId: this.sourceId,
          };
          if (this.controller.signal.aborted) log.debug('MCP initialization cancelled', fields);
          else
            log.warn(
              'MCP initialization failed; source remains unavailable for this session',
              fields,
            );
          throw error;
        })
        .finally(() => {
          this.settled = true;
        });
    }
    let onAbort!: () => void;
    try {
      return await Promise.race([
        this.pending,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.waiters--;
      if (!this.waiters && !this.settled) this.controller.abort();
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    this.closing = (async () => {
      // Initialization failures have already been reported and belong to the invoking call.
      if (this.pending) await Promise.allSettled([this.pending]);
      if (this.peer) await this.peer.close();
    })();
    return this.closing;
  }
}
