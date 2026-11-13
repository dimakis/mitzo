import { z } from 'zod';
import { apiFetch } from './api-fetch';
import { DEFAULT_MITZO_PROFILE_ID, DEFAULT_MITZO_PROFILE_REVISION } from '@mitzo/protocol';
import { ExplicitLocalInventorySchema } from './explicit-local-chat';
import { resolveRuntimeTarget } from './chat-runtime-route';
import { createChatRuntimeSelection, type ChatRuntimeSelection } from './chat-runtime-selection';

export const ClaudeLoginAttempt = z.object({
  requestId: z.uuid(),
  accountId: z.string(),
  label: z.string(),
  state: z.enum([
    'preparing',
    'pending',
    'verifying',
    'connected',
    'cancelled',
    'failed',
    'interrupted',
  ]),
  expiresAt: z.number(),
  errorCode: z.string().nullable(),
  diagnosticId: z.string().nullable(),
  url: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        (url.origin === 'https://claude.com' && url.pathname === '/cai/oauth/authorize') ||
        (url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize')
      );
    })
    .optional(),
});
export type ClaudeLoginAttempt = z.infer<typeof ClaudeLoginAttempt>;
export const ClaudeAccountSnapshot = z.object({
  enabled: z.boolean(),
  attempts: z.array(ClaudeLoginAttempt),
  accounts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      email: z.email(),
      planType: z.enum(['pro', 'max']),
      verifiedAt: z.number(),
    }),
  ),
});
export type ClaudeAccountSnapshot = z.infer<typeof ClaudeAccountSnapshot>;
const endpoint = '/api/claude-accounts';
export async function readClaudeAccounts(signal?: AbortSignal) {
  const response = await apiFetch(endpoint, { cache: 'no-store', signal });
  if (!response.ok)
    throw Error('Claude account status is unavailable. Check status before continuing.');
  return ClaudeAccountSnapshot.parse(await response.json());
}
export class ClaudeAccountChangeError extends Error {
  constructor(readonly diagnosticId?: string) {
    super('Claude account change could not be confirmed. Check status before continuing.');
  }
}
async function mutate(path: string, body: unknown, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 20_000);
  let rejectAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () =>
      reject(
        Error('Claude account change could not be confirmed. Check status before continuing.'),
      );
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await apiFetch(endpoint + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          const failure = z.object({ diagnosticId: z.uuid() }).safeParse(value);
          throw new ClaudeAccountChangeError(
            failure.success ? failure.data.diagnosticId : undefined,
          );
        }
        return value;
      })(),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
export async function changeClaudeLogin(path: string, body: unknown, signal?: AbortSignal) {
  return ClaudeLoginAttempt.parse(await mutate(path, body, signal));
}
export async function removeClaudeAccount(accountId: string, signal?: AbortSignal) {
  return ClaudeAccountSnapshot.parse(
    await mutate(`/accounts/${encodeURIComponent(accountId)}/remove`, {}, signal),
  );
}

/** Fresh public route identity for an unsent draft; this does not admit or execute a command. */
export async function readLocalAccountChatIntent(
  accountId: string,
  provider: 'anthropic-claude' | 'anthropic-api' | 'openai',
  modelId?: string,
): Promise<ChatRuntimeSelection> {
  const response = await apiFetch('/api/chat/runtime/capabilities?workspaceDefaults=1');
  if (!response.ok) throw Error('Local Mac choices unavailable');
  const inventory = ExplicitLocalInventorySchema.parse(await response.json());
  const account = inventory.accounts.find(
    (row) => row.account.accountId === accountId && row.account.provider === provider,
  );
  if (
    !account ||
    !inventory.locations.some((row) => row.location === 'local' && row.status === 'configured')
  )
    throw Error('The connected account has no Local Mac route');
  if (modelId && !account.models.some((model) => model.id === modelId))
    throw Error('Selected model is unavailable');
  const intent: ChatRuntimeSelection = {
    ...createChatRuntimeSelection(),
    account: {
      accountId,
      model:
        modelId ?? account.models.find((row) => row.id === 'sonnet')?.id ?? account.models[0].id,
      reasoningEffort: null,
    },
    accountReference: account.account,
    agentProfile: {
      kind: 'builtin',
      profileId: DEFAULT_MITZO_PROFILE_ID,
      revision: DEFAULT_MITZO_PROFILE_REVISION,
    },
    execution: { location: 'local', targetId: null },
    capabilityRevision: inventory.capabilityRevision,
  };
  intent.execution.targetId = resolveRuntimeTarget(intent, inventory);
  return intent;
}
export function readClaudeChatIntent(accountId: string): Promise<ChatRuntimeSelection> {
  return readLocalAccountChatIntent(accountId, 'anthropic-claude');
}
