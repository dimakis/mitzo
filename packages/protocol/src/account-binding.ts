import { z } from 'zod';

export const AccountProviderSchema = z.enum(['anthropic-vertex', 'openai-codex', 'openai']);

/** A routing reference, never credentials. Runtime resolves current authorization
 * and model availability before sending any context through this account.
 */
export const AccountBindingSchema = z.strictObject({
  accountId: z.string().trim().min(1),
  accountLabel: z.string().trim().min(1),
  provider: AccountProviderSchema,
  model: z.string().trim().min(1),
  profileRevision: z.string().trim().min(1),
});

export type AccountProvider = z.infer<typeof AccountProviderSchema>;
export type ValidAccountBinding = z.infer<typeof AccountBindingSchema>;
/** Durable fail-closed sentinel used when a stored binding cannot be parsed. */
export type UnavailableAccountBinding = Omit<ValidAccountBinding, 'provider'> & {
  provider: 'unavailable';
};
/** Compatibility shape used by existing callers. Persisted values still pass
 * through AccountBindingSchema and fail closed when the provider is unsupported.
 */
export type AccountBinding = Omit<ValidAccountBinding, 'provider'> & { provider: string };
