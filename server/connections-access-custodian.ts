import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerAuthSession, type AuthSession } from './auth.js';
import type { CustodianClient } from './symposium-custodian-proxy.js';
import type { ConnectionsAccessSources } from './connections-access.js';

// Read only display metadata; the retained owner still controls authentication and execution.
const metadata = z.object({
  connections: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        label: z.string().min(1).max(120),
        revision: z.number().int().positive(),
        state: z.enum([
          'connected',
          'disconnected',
          'reauth_required',
          'connecting',
          'disconnecting',
          'recovery_required',
        ]),
        account: z
          .object({ email: z.string().max(254), planType: z.enum(['free', 'plus', 'pro']) })
          .optional(),
      }),
    )
    .max(100),
});

/** The caller supplies middleware-verified authority, never a browser body/token.
 * Controller mode always uses the closed existing personal.list operation. */
export function personalInventorySource(
  auth: AuthSession,
  client?: CustodianClient,
  local?: ConnectionsAccessSources['personal'],
): ConnectionsAccessSources['personal'] {
  if (!client) return local;
  return async (signal) => {
    const invalidation = new AbortController();
    const current = AbortSignal.any([signal, invalidation.signal]);
    let invalidated = false;
    const unregister = registerAuthSession(auth, () => {
      invalidated = true;
      invalidation.abort();
      client.invalidate(auth.id);
    });
    const assertCurrent = () => {
      current.throwIfAborted();
      if (invalidated || auth.expiresAt <= Date.now())
        throw new Error('Operator authorization unavailable');
    };
    let stop: (() => void) | undefined;
    try {
      assertCurrent();
      const response = await Promise.race([
        client.request(
          {
            operation: 'personal.list',
            requestId: randomUUID(),
            body: {},
            query: {},
            authorization: { id: auth.id, expiresAt: auth.expiresAt },
          },
          undefined,
          current,
        ),
        new Promise<never>((_, reject) => {
          stop = () => reject(new Error('Personal inventory read cancelled'));
          current.addEventListener('abort', stop, { once: true });
          if (current.aborted) stop();
        }),
      ]);
      assertCurrent();
      if (response.status !== 200) throw new Error('Personal inventory unavailable');
      return metadata.parse(response.body).connections;
    } finally {
      if (stop) current.removeEventListener('abort', stop);
      unregister();
    }
  };
}
