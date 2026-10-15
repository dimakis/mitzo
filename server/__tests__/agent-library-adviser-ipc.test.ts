import { EventEmitter } from 'node:events';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { operatorAuthMiddleware } from '../auth.js';
import { AgentLibraryAdviser } from '../agent-library-adviser.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { createAgentLibraryRouter } from '../agent-library-router.js';
import { SymposiumCustodianController } from '../symposium-custodian-controller.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import { createCustodianIpcClient, serveCustodianController } from '../symposium-custodian-ipc.js';

class Channel extends EventEmitter {
  peer!: Channel;
  connected = true;
  send(message: unknown) {
    queueMicrotask(() => this.peer.emit('message', message));
    return true;
  }
}

it.each(['abort', 'timeout', 'disconnect'] as const)(
  'cancels retained-owner advice through the inference signal on %s',
  async (mode) => {
    const parent = new Channel(),
      child = new Channel();
    parent.peer = child;
    child.peer = parent;
    const store = new AgentLibraryStore(':memory:');
    const signals: AbortSignal[] = [];
    let release!: () => void;
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let active = 0;
    const adviser = new AgentLibraryAdviser(async (config) => {
      const signal = config.signal!;
      const first = signals.length === 0;
      signals.push(signal);
      return {
        provider: 'fake',
        async *turn() {
          active++;
          try {
            if (first)
              await new Promise<void>((resolve) => {
                release = resolve;
                signal.addEventListener('abort', () => resolve(), { once: true });
                if (signal.aborted) resolve();
              });
            signal.throwIfAborted();
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Ready for the next profile.' },
            };
          } finally {
            if (first && mode === 'disconnect') await cleanup;
            active--;
          }
        },
      };
    });
    const app = express();
    app.use(express.json(), operatorAuthMiddleware);
    app.use('/api/agent-library', createAgentLibraryRouter(store, { adviser }));
    const owner = new SymposiumCustodianController({
      pause: vi.fn(),
      resume: vi.fn(),
      invalidate: vi.fn(),
      drain: async () => {},
      dispatch: (command, assertCurrent, approval, signal) =>
        dispatchCustodianHttp(app, command, assertCurrent, approval, signal),
    });
    const stopped = serveCustodianController(parent, owner);
    let drained = false;
    void stopped.then(() => {
      drained = true;
    });
    const client = createCustodianIpcClient(child, {
      requestTimeoutMs: mode === 'timeout' ? 500 : 60_000,
    });
    const abort = new AbortController();
    const command = (requestId: string) => ({
      requestId,
      operation: 'library.advice' as const,
      query: {},
      body: {
        accountId: 'work',
        model: 'luna',
        messages: [{ role: 'user', content: 'Help with this profile' }],
        draft: '{}',
      },
      authorization: { id: `advisor-ipc-${mode}`, expiresAt: Date.now() + 60_000 },
    });
    const first = client
      .request(command('first'), undefined, abort.signal)
      .catch((error: Error) => error.message);
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      for (const frame of [
        { kind: 'advice-request-cancel', epoch: 2, requestId: 'first' },
        { kind: 'advice-request-cancel', epoch: 1, requestId: 'unrelated' },
        { kind: 'advice-request-cancel', epoch: 1, requestId: 'first', extra: true },
        { kind: 'read-request-cancel', epoch: 1, requestId: 'first' },
      ])
        child.send(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signals[0].aborted).toBe(false);
      if (mode === 'abort') abort.abort();
      if (mode === 'disconnect') {
        child.emit('disconnect');
        parent.emit('disconnect');
      }
      await vi.waitFor(() => expect(signals[0].aborted).toBe(true), { timeout: 1000 });
      expect(await first).toBe(
        mode === 'disconnect' ? 'Custodian channel unavailable' : 'Custodian advice cancelled',
      );
      if (mode === 'disconnect') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(active).toBe(1);
        expect(drained).toBe(false);
        finishCleanup();
      }
      await vi.waitFor(() => expect(active).toBe(0));
      if (mode !== 'disconnect') {
        await expect(client.request(command('next-profile'))).resolves.toEqual({
          status: 200,
          body: { text: 'Ready for the next profile.' },
        });
        expect(signals).toHaveLength(2);
      }
      expect(store.list('user')).toEqual({ drafts: [], versions: [] });
    } finally {
      release?.();
      finishCleanup();
      child.emit('disconnect');
      parent.emit('disconnect');
      await first;
      await stopped;
      store.close();
    }
  },
);
