import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';

const Profile = z
  .object({
    accountId: z.string().min(1),
    accountLabel: z.string().min(1),
    credentialRef: z.string().refine(isAbsolute).optional(),
    email: z.string().min(1),
    planType: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    sandboxProvider: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)
      .optional(),
    sandboxProviderType: z.literal('openai-codex-oauth').optional(),
    sandboxProviderId: z.string().min(1).max(128).optional(),
    sandboxGrantId: z.string().min(1).max(128).optional(),
    model: z.string().min(1),
  })
  .strict();
export type CodexAccountProfile = z.infer<typeof Profile>;

/** Read-only preflight. The caller owns initialization and connection cleanup.
 * Recheck on restart and before every turn; never substitute API billing.
 * Email + plan are the identity fields exposed by the installed account/read protocol.
 * They do not prove workspace identity or protect against a concurrent external login change.
 */
export async function verifyCodexAccount(
  client: { request(method: string, params: Record<string, unknown>): Promise<unknown> },
  configuration: CodexAccountProfile,
  stored?: AccountBinding,
): Promise<AccountBinding> {
  const parsed = Profile.safeParse(configuration);
  if (!parsed.success) throw new Error('Invalid Codex account profile');
  const profile = parsed.data;
  const binding: AccountBinding = {
    accountId: profile.accountId,
    accountLabel: profile.accountLabel,
    provider: 'openai-codex',
    model: profile.model,
    profileRevision: createHash('sha256')
      .update(
        JSON.stringify([
          'openai-codex',
          profile.credentialRef,
          profile.email,
          profile.planType,
          profile.workspaceId,
          profile.sandboxProvider,
          profile.sandboxProviderType,
          profile.sandboxProviderId,
          profile.sandboxGrantId,
        ]),
      )
      .digest('hex'),
  };
  if (
    stored &&
    (stored.accountId !== binding.accountId ||
      stored.provider !== binding.provider ||
      stored.model !== binding.model ||
      stored.profileRevision !== binding.profileRevision)
  ) {
    throw new Error(
      'This task is bound to another Codex account configuration or model. Start a new task.',
    );
  }
  const response = z
    .object({
      account: z.object({
        type: z.literal('chatgpt'),
        email: z.string(),
        planType: z.string(),
      }),
    })
    .safeParse(await client.request('account/read', { refreshToken: false }));
  if (
    !response.success ||
    response.data.account.email !== profile.email ||
    response.data.account.planType !== profile.planType
  ) {
    throw new Error(
      'Codex account does not match the configured ChatGPT login and plan. Check sign-in and retry.',
    );
  }
  return stored ?? binding;
}
