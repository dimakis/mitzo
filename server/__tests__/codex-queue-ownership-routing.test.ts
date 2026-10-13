import type { Router } from 'express';
import { expect, it, vi } from 'vitest';
import { createCodexQueueRouter } from '../codex-queue-routes.js';
const account = {
  accountId: 'a',
  accountLabel: 'Account',
  provider: 'openai-codex',
  model: 'fixture',
  profileRevision: 'r',
};
const original = { id: 'original', expiresAt: Date.now() + 10000 };
function invoke(router: Router, path: string, operator?: typeof original) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    const req = {
      method: 'POST',
      url: '/session/codex-queue/' + path,
      headers: {},
      body: { recoveryId: '11111111-1111-4111-8111-111111111111', sourceCommandId: 'source' },
    };
    const res = {
      locals: { authSession: operator },
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        resolve({ status, body });
      },
    };
    (
      router as Router & {
        handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
      }
    ).handle(req, res, (error) => reject(error ?? Error('Unmatched queue route')));
  });
}
it.each(['waiting/cancel', 'retry', 'capacity-retry', 'capacity-stop', 'reattach'])(
  'guards %s before any queue/provider mutation and ignores request auth claims',
  async (path) => {
    const effect = vi.fn();
    const router = createCodexQueueRouter({
      authorizeMutation: (_id, auth) => {
        if (auth?.id !== original.id) throw Error('foreign');
      },
      binding: () => account,
      overview: () => ({ queued: [], cancelledIds: [], hasMore: false }),
      cancel: () => {
        effect();
        return 'cancelled';
      },
      retry: async () => {
        effect();
        return 'queued';
      },
      capacityRetry: async () => {
        effect();
        return 'queued';
      },
      capacityStop: async () => {
        effect();
        return 'stopped';
      },
      reattach: async () => {
        effect();
        return 'ready';
      },
    });
    await expect(invoke(router, path, { ...original, id: 'foreign' })).resolves.toMatchObject({
      status: 403,
    });
    await expect(invoke(router, path)).resolves.toMatchObject({ status: 403 });
    expect(effect).not.toHaveBeenCalled();
    await expect(invoke(router, path, original)).resolves.toMatchObject({ status: 200 });
    expect(effect).toHaveBeenCalledTimes(1);
  },
);
