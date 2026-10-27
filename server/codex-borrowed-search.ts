import { z } from 'zod';
import type { CodexLifecycleTransport } from './codex-app-server-client.js';

type Params = Record<string, unknown>;
interface Rpc {
  request(method: string, params: Params): Promise<unknown>;
}
const identity = z.object({ id: z.string().min(1) });

/** One search-only child on an already authenticated transport. This adapter
 * owns only its child thread; initialize/close never reattach or close the parent.
 * The caller keeps the original transport's lifecycle and ownership fences.
 */
export class BorrowedCodexSearch {
  private callbacks?: CodexLifecycleTransport;
  private threadId?: string;
  private turnId?: string;
  private turnRequested = false;
  private terminalTurns = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private closed = false;

  constructor(
    private readonly client: Rpc,
    private readonly parentThreadId: string,
    private readonly assertCurrent: () => Promise<void>,
  ) {}

  attach(callbacks: CodexLifecycleTransport) {
    if (this.callbacks || this.closed) throw Error('Search transport unavailable');
    this.callbacks = callbacks;
    return {
      initialize: () => this.assertCurrent(),
      request: (method: string, params: Params) => {
        if (this.closed) return Promise.reject(Error('Search transport closed'));
        const work = this.request(method, params);
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work)).catch(() => {});
        return work;
      },
      close: () => this.close(),
    };
  }

  private async request(method: string, params: Params): Promise<unknown> {
    await this.assertCurrent();
    if (this.closed) throw Error('Search transport closed');
    if (
      !['config/read', 'thread/start', 'turn/start'].includes(method) ||
      (method === 'thread/start' && this.threadId) ||
      (method === 'turn/start' &&
        (!this.threadId || params.threadId !== this.threadId || this.turnId))
    )
      throw Error('Search RPC unavailable');
    if (method === 'turn/start') this.turnRequested = true;
    const result = await this.client.request(
      method,
      method === 'thread/start' ? { ...params, ephemeral: true } : params,
    );
    // Capture accepted child identities even if cancellation raced the RPC.
    // Cleanup waits for these receipts before interrupting/unsubscribing.
    if (method === 'thread/start') {
      const { thread } = z.object({ thread: identity }).parse(result);
      if (thread.id === this.parentThreadId) throw Error('Search thread aliases parent');
      this.threadId = thread.id;
    }
    if (method === 'turn/start') this.turnId = z.object({ turn: identity }).parse(result).turn.id;
    await this.assertCurrent();
    if (this.closed) throw Error('Search transport closed');
    return result;
  }

  owns(params: Params): boolean {
    return !!this.threadId && params.threadId === this.threadId;
  }

  notification(method: string, params: Params): boolean {
    if (!this.owns(params)) return false;
    if (method === 'turn/completed') {
      const turn = identity.safeParse(params.turn);
      if (turn.success) this.terminalTurns.add(turn.data.id);
    }
    if (!this.closed) this.callbacks?.onNotification(method, params);
    return true;
  }

  transportClosed(error: Error): void {
    this.closed = true;
    this.callbacks?.onClose(error);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      // These cleanup RPCs carry only identities from this child's receipts.
      // They confer no new read or model execution authority after revocation.
      if (!this.threadId) return;
      if (this.turnRequested && !this.turnId) throw Error('Search turn outcome unknown');
      if (this.turnId && !this.terminalTurns.has(this.turnId))
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.turnId,
        });
      await this.client.request('thread/unsubscribe', { threadId: this.threadId });
    })();
    return this.closing;
  }
}
