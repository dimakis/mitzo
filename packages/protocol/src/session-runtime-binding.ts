import { z } from 'zod';
import { AccountProviderSchema } from './account-binding.js';

const reference = z.string().min(1).max(200).regex(/^\S+$/);

/** Dormant routing description only. Validation does not authorize an account,
 * admit a provider, or prove workspace isolation. Physical runtime identity and
 * ownership remain in the existing runtime/workspace records. No credentials.
 */
export const SessionRuntimeBindingV1Schema = z
  .strictObject({
    version: z.literal(1),
    account: z.strictObject({
      accountId: reference,
      provider: AccountProviderSchema,
      profileRevision: reference,
    }),
    harness: z.strictObject({
      implementation: z.enum(['codex', 'claude-sdk', 'responses', 'gemini']),
    }),
    execution: z.strictObject({ location: z.enum(['local', 'openshell']) }),
  })
  .superRefine((binding, context) => {
    const providers = {
      codex: ['openai-codex', 'openai'],
      'claude-sdk': ['anthropic-vertex'],
      responses: ['openai'],
      gemini: ['google-vertex'],
    };
    if (!providers[binding.harness.implementation].includes(binding.account.provider)) {
      context.addIssue({
        code: 'custom',
        path: ['harness', 'implementation'],
        message: 'Harness implementation does not match account provider',
      });
    }
  });

export type SessionRuntimeBindingV1 = z.infer<typeof SessionRuntimeBindingV1Schema>;
