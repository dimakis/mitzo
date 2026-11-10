import { z } from 'zod';
import { apiFetch } from './api-fetch';

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
export async function readClaudeAccounts() {
  const response = await apiFetch(endpoint, { cache: 'no-store' });
  if (!response.ok)
    throw Error('Claude account status is unavailable. Check status before continuing.');
  return ClaudeAccountSnapshot.parse(await response.json());
}
export async function changeClaudeLogin(path: string, body: unknown) {
  const response = await apiFetch(endpoint + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw Error('Claude sign-in could not be confirmed. Check status before continuing.');
  return ClaudeLoginAttempt.parse(await response.json());
}
