import { z } from 'zod';
import { SessionRuntimeBindingV1Schema, type SessionRuntimeBindingV1 } from '@mitzo/protocol';

const accountReference = SessionRuntimeBindingV1Schema.shape.account;
const reference = accountReference.shape.accountId;
const harness = SessionRuntimeBindingV1Schema.shape.harness.shape.implementation;
const uniqueReferences = z.array(reference).refine((ids) => new Set(ids).size === ids.length);

const Request = z.strictObject({
  account: accountReference,
  harness,
  targetId: reference,
  mode: z.enum(['ask', 'agent', 'auto']),
  skillCeiling: z.array(z.string().min(1)).optional(),
});

const Account = z.discriminatedUnion('provider', [
  z.strictObject({
    ...accountReference.shape,
    provider: z.literal('openai-codex'),
    planType: z.string().trim().min(1),
    auth: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('host-login') }),
      z.strictObject({ kind: z.literal('brokered-oauth'), targetIds: uniqueReferences.min(1) }),
      z.strictObject({ kind: z.literal('sandbox-chatgpt') }),
    ]),
  }),
  z.strictObject({
    ...accountReference.shape,
    provider: z.literal('openai'),
    auth: z.strictObject({
      kind: z.literal('api-credential'),
      openshellTargetIds: uniqueReferences,
    }),
  }),
  z.strictObject({
    ...accountReference.shape,
    provider: z.literal('anthropic-vertex'),
    auth: z.strictObject({ kind: z.literal('vertex-adc') }),
  }),
  z.strictObject({
    ...accountReference.shape,
    provider: z.literal('google-vertex'),
    auth: z.strictObject({ kind: z.literal('vertex-adc') }),
  }),
]);

const Target = z.discriminatedUnion('location', [
  z.strictObject({ targetId: reference, location: z.literal('local') }),
  z.strictObject({
    targetId: reference,
    location: z.literal('openshell'),
    ownership: z.enum(['dedicated-ordinary', 'shared-or-retained']),
    openaiApi: z.enum(['enabled', 'disabled']),
  }),
]);

const Catalog = z.strictObject({
  deployment: z.enum(['ordinary', 'custodian']),
  enabledHarnesses: z
    .array(harness)
    .max(4)
    .refine((implementations) => new Set(implementations).size === implementations.length),
  accounts: z.array(Account),
  targets: z.array(Target),
});

export type OrdinarySessionRuntimeRequest = z.infer<typeof Request>;

/** Injected server configuration projection, not a second account registry.
 * Auth kinds describe valid configured profile classes, never observed login or
 * authorization. brokered-oauth requires a complete openai-codex-oauth profile
 * (provider/type/ID/grant and no host login); host-login requires the exclusive
 * host login profile. API target mappings require an explicit sandbox provider.
 * Each target reference must identify that account's configured provider route.
 * Vertex classes require the configured project/region/ADC profile. The future
 * trusted projection must validate those source constraints before constructing
 * this credential-free catalog; no loader or projection is introduced here.
 */
export type OrdinarySessionRuntimeCatalog = z.infer<typeof Catalog>;

export type OrdinarySessionRuntimeRejectionCode =
  | 'invalid_request'
  | 'invalid_catalog'
  | 'ambiguous_account'
  | 'account_unavailable'
  | 'account_identity_mismatch'
  | 'ambiguous_target'
  | 'target_unavailable'
  | 'harness_disabled'
  | 'unsupported_tuple'
  | 'native_auth_ordinary_unsupported'
  | 'ambiguous_codex_api_plan'
  | 'auth_configuration_incompatible'
  | 'skill_ceiling_unsupported'
  | 'mode_unsupported'
  | 'target_not_dedicated_ordinary'
  | 'custodian_requires_dedicated_openshell';

export type OrdinarySessionRuntimeResolution =
  | { status: 'compatible'; binding: SessionRuntimeBindingV1; targetId: string }
  | { status: 'rejected'; code: OrdinarySessionRuntimeRejectionCode };

function rejected(code: OrdinarySessionRuntimeRejectionCode): OrdinarySessionRuntimeResolution {
  return { status: 'rejected', code };
}

/** Pure, dormant configuration compatibility check. Never reads credentials,
 * environment, files or provider state; never starts a runtime or changes policy.
 * Compatible is not authenticated, authorized, isolated or ready to execute.
 * V1 does not persist targetId: this result is not a durably pinned route and
 * cannot be passed into execution until target persistence/admission is extended.
 */
export function resolveOrdinarySessionRuntime(
  request: unknown,
  catalog: unknown,
): OrdinarySessionRuntimeResolution {
  const selection = Request.safeParse(request);
  if (!selection.success) return rejected('invalid_request');
  const configuration = Catalog.safeParse(catalog);
  if (!configuration.success) return rejected('invalid_catalog');
  const { accounts, targets, enabledHarnesses, deployment } = configuration.data;
  if (new Set(accounts.map((account) => account.accountId)).size !== accounts.length)
    return rejected('ambiguous_account');
  if (new Set(targets.map((target) => target.targetId)).size !== targets.length)
    return rejected('ambiguous_target');

  const targetsById = new Map(targets.map((target) => [target.targetId, target]));
  for (const account of accounts) {
    const targetIds =
      account.provider === 'openai'
        ? account.auth.openshellTargetIds
        : account.provider === 'openai-codex' && account.auth.kind === 'brokered-oauth'
          ? account.auth.targetIds
          : [];
    if (targetIds.some((id) => targetsById.get(id)?.location !== 'openshell'))
      return rejected('invalid_catalog');
  }

  const chosen = selection.data;
  const account = accounts.find((candidate) => candidate.accountId === chosen.account.accountId);
  if (!account) return rejected('account_unavailable');
  if (
    account.provider !== chosen.account.provider ||
    account.profileRevision !== chosen.account.profileRevision
  )
    return rejected('account_identity_mismatch');
  const target = targetsById.get(chosen.targetId);
  if (!target) return rejected('target_unavailable');
  if (!enabledHarnesses.includes(chosen.harness)) return rejected('harness_disabled');

  if (account.provider === 'openai-codex') {
    if (account.auth.kind === 'sandbox-chatgpt')
      return rejected('native_auth_ordinary_unsupported');
    // Legacy profiles allow this ambiguous value. Ordinary selection must not
    // reinterpret it as a subscribed ChatGPT identity or switch to API billing.
    if (account.planType.toLowerCase() === 'api') return rejected('ambiguous_codex_api_plan');
  }

  const supported =
    account.provider === 'openai-codex'
      ? chosen.harness === 'codex'
      : account.provider === 'openai'
        ? (chosen.harness === 'responses' && target.location === 'local') ||
          (chosen.harness === 'codex' && target.location === 'openshell')
        : account.provider === 'anthropic-vertex'
          ? chosen.harness === 'claude-sdk' && target.location === 'local'
          : chosen.harness === 'gemini' && target.location === 'local';
  if (!supported) return rejected('unsupported_tuple');
  if (chosen.harness === 'codex' && chosen.skillCeiling !== undefined)
    return rejected('skill_ceiling_unsupported');
  if (target.location === 'openshell' && target.ownership !== 'dedicated-ordinary')
    return rejected('target_not_dedicated_ordinary');
  if (target.location === 'openshell' && chosen.mode === 'ask') return rejected('mode_unsupported');
  if (
    deployment === 'custodian' &&
    (account.provider === 'openai' || account.provider === 'openai-codex') &&
    target.location !== 'openshell'
  )
    return rejected('custodian_requires_dedicated_openshell');

  if (account.provider === 'openai-codex') {
    if (
      (target.location === 'local' && account.auth.kind !== 'host-login') ||
      (target.location === 'openshell' &&
        (account.auth.kind !== 'brokered-oauth' ||
          !account.auth.targetIds.includes(target.targetId)))
    )
      return rejected('auth_configuration_incompatible');
  } else if (
    account.provider === 'openai' &&
    target.location === 'openshell' &&
    (target.openaiApi !== 'enabled' || !account.auth.openshellTargetIds.includes(target.targetId))
  )
    return rejected('auth_configuration_incompatible');

  return {
    status: 'compatible',
    binding: {
      version: 1,
      account: { ...chosen.account },
      harness: { implementation: chosen.harness },
      execution: { location: target.location },
    },
    targetId: target.targetId,
  };
}
