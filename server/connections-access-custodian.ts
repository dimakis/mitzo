import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerAuthSession, type AuthSession } from './auth.js';
import { CatalogModel } from './model-catalog.js';
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

const accountCatalog = z
  .array(
    z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]+$/),
      label: z.string().min(1),
      provider: z.enum(['openai', 'anthropic-vertex', 'google-vertex', 'openai-codex']),
      billing: z.string(),
      personalConnection: z
        .object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
          revision: z.number().int().positive(),
        })
        .strict()
        .optional(),
      models: z.array(CatalogModel),
      modelDiscovery: z.object({ updatedAt: z.number().optional(), stale: z.boolean() }),
      capabilities: z.object({ streaming: z.boolean(), tools: z.boolean(), images: z.boolean() }),
    }),
  )
  .transform((accounts) =>
    accounts.map((account) => ({
      ...account,
      modelDiscovery: {
        updatedAt: account.modelDiscovery.updatedAt,
        stale: account.modelDiscovery.stale,
      },
    })),
  );

/** Closed existing metadata operations; authorization stays with the retained owner. */
function custodianInventorySource<T>(
  auth: AuthSession,
  client: CustodianClient,
  operation: 'personal.list' | 'account.catalog',
  parse: (body: unknown) => T,
): (signal: AbortSignal) => Promise<T> {
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
            operation,
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
      return parse(response.body);
    } finally {
      if (stop) current.removeEventListener('abort', stop);
      unregister();
    }
  };
}

/** Middleware-verified browser authority only, never a request body or token. */
export function personalInventorySource(
  auth: AuthSession,
  client?: CustodianClient,
  local?: ConnectionsAccessSources['personal'],
): ConnectionsAccessSources['personal'] {
  return client
    ? custodianInventorySource(
        auth,
        client,
        'personal.list',
        (body) => metadata.parse(body).connections,
      )
    : local;
}
export function symposiumAccountsInventorySource(
  auth: AuthSession,
  client?: CustodianClient,
  local?: ConnectionsAccessSources['symposiumAccounts'],
): ConnectionsAccessSources['symposiumAccounts'] {
  return client
    ? custodianInventorySource(auth, client, 'account.catalog', (body) =>
        accountCatalog.parse(body),
      )
    : local;
}
