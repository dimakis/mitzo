import { z } from 'zod';
import { AccountProviderSchema } from './account-binding.js';

const reference = z.string().min(1).max(200).regex(/^\S+$/);

/** Dormant routing description only. Validation does not authorize an account,
 * admit a provider, or prove workspace isolation. Physical runtime identity and
 * ownership remain in the existing runtime/workspace records. No credentials.
 */
const runtimeBindingV1 = z.strictObject({
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
});

function validateHarness(
  binding: Pick<z.infer<typeof runtimeBindingV1>, 'account' | 'harness'>,
  context: z.RefinementCtx,
): void {
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
}

export const SessionRuntimeBindingV1Schema = runtimeBindingV1.superRefine(validateHarness);

/** Logical configured target only. Its revision is supplied by trusted server
 * configuration, not a client or evidence of authorization/physical ownership.
 */
export const SessionRuntimeBindingV2Schema = runtimeBindingV1
  .extend({
    version: z.literal(2),
    execution: z.strictObject({
      location: z.enum(['local', 'openshell']),
      targetId: reference,
      targetRevision: reference,
    }),
  })
  .superRefine(validateHarness);

export const SessionRuntimeBindingSchema = z.discriminatedUnion('version', [
  SessionRuntimeBindingV1Schema,
  SessionRuntimeBindingV2Schema,
]);

export type SessionRuntimeBindingV1 = z.infer<typeof SessionRuntimeBindingV1Schema>;
export type SessionRuntimeBindingV2 = z.infer<typeof SessionRuntimeBindingV2Schema>;
export type SessionRuntimeBinding = z.infer<typeof SessionRuntimeBindingSchema>;
