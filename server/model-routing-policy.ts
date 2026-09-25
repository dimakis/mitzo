import {
  ExecutionPolicySchema,
  ExecutionOverrideSchema,
  type ExecutionPolicy,
  type ExecutionOverride,
  type ExecutionSelection,
  type AccountBinding,
} from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import { z } from 'zod';

type Mode = 'primary' | 'fallback' | 'escalation';
type Capability = { tools: boolean; context: boolean; route: boolean };
type Price = { kind: 'known'; maxUsdPerMillionTokens: number } | { kind: 'unknown' };
type Usage = {
  attempts: number;
  tokens: number;
  costUsd: number;
  replans: number;
  fallbacks: number;
  escalations: number;
};
const UsageSchema = z.strictObject({
  attempts: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
  replans: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  escalations: z.number().int().nonnegative(),
});
const ModeSchema = z.enum(['primary', 'fallback', 'escalation']);
type Input = {
  policy: ExecutionPolicy;
  accountProfiles: Pick<AccountProfiles, 'catalog' | 'resolve' | 'validateModel'>;
  capabilities: (binding: AccountBinding) => Capability;
  pricing: (binding: AccountBinding) => Price;
  usage: Usage;
  requestedMode?: Mode;
  overrides?: { goal?: ExecutionOverride; task?: ExecutionOverride; seat?: ExecutionOverride };
};
type DecisionCode =
  | 'invalid_policy'
  | 'account_change'
  | 'grant_change'
  | 'profile_change'
  | 'substitution_unapproved'
  | 'budget_exceeded'
  | 'unknown_price'
  | 'model_unavailable'
  | 'effort_unavailable'
  | 'capability_unavailable';
type Decision = { kind: 'decision_required'; code: DecisionCode; message: string };
type SelectionAudit = {
  role: string;
  policyId: string;
  policyRevision: string;
  profileBinding: ExecutionPolicy['profileBinding'];
  policyPrimary: ExecutionSelection;
  requested: ExecutionSelection;
  actual: ExecutionSelection;
  requestedMode: Mode;
  overrideSource: 'role' | 'goal' | 'task' | 'seat';
  substitutionReason: string | null;
  accountBinding: AccountBinding;
  contextGrant: ExecutionPolicy['contextGrant'];
  authorityGrant: ExecutionPolicy['authorityGrant'];
  price: Price;
};
type Selected = {
  kind: 'selected';
  audit: SelectionAudit;
  /** Pass these pins into a separately admitted O0 work order. This is not runtime admission. */
  workOrderPins: {
    role: string;
    policyRevision: string;
    accountBinding: AccountBinding;
    reasoningEffort: string | null;
    contextGrant: ExecutionPolicy['contextGrant'];
    authorityGrant: ExecutionPolicy['authorityGrant'];
    budget: { maxAttempts: number; maxTokens: number; maxCostUsd: number | null };
  };
};

const messages: Record<DecisionCode, string> = {
  invalid_policy: 'Execution policy or usage is invalid; revise the policy.',
  account_change: 'Account change requires an approved policy revision.',
  grant_change: 'Grant change requires an approved policy revision.',
  profile_change: 'Profile change requires an approved policy revision.',
  substitution_unapproved: 'Selection requires an approved policy revision.',
  budget_exceeded: 'Execution budget is exhausted; request a new limit.',
  unknown_price:
    'Price is unknown under the cost cap; approve an unknown-cost policy or choose another route.',
  model_unavailable: 'Selected model is unavailable for this account.',
  effort_unavailable: 'Selected reasoning effort is unavailable for this model.',
  capability_unavailable: 'Required runtime capability is unavailable or unverified.',
};
const decision = (code: DecisionCode): Decision => ({
  kind: 'decision_required',
  code,
  message: messages[code],
});
const sameSelection = (a: ExecutionSelection, b: ExecutionSelection): boolean =>
  a.accountId === b.accountId && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
const sameGrant = (
  a: ExecutionPolicy['contextGrant'],
  b: ExecutionPolicy['contextGrant'],
): boolean => a.grantId === b.grantId && a.revision === b.revision;

/** Pure, fail-closed selection. Caller must persist the audit and atomically admit the work order. */
export function resolveRoleExecution(input: Input): Decision | Selected {
  const parsed = ExecutionPolicySchema.safeParse(input.policy);
  const usage = UsageSchema.safeParse(input.usage);
  const requestedMode = ModeSchema.safeParse(input.requestedMode ?? 'primary');
  if (!parsed.success || !usage.success || !requestedMode.success)
    return decision('invalid_policy');
  const policy = parsed.data;
  let mode: Mode = requestedMode.data;
  const overrideEntries = (['seat', 'task', 'goal'] as const).map((source) => ({
    source,
    value: input.overrides?.[source],
  }));
  const canonicalOverrides: typeof overrideEntries = [];
  for (const { source, value } of overrideEntries) {
    const canonical = value === undefined ? undefined : ExecutionOverrideSchema.safeParse(value);
    if (canonical && !canonical.success) return decision('invalid_policy');
    const normalized = canonical?.data;
    canonicalOverrides.push({ source, value: normalized });
    if (
      normalized?.profileBinding &&
      (normalized.profileBinding.profileId !== policy.profileBinding.profileId ||
        normalized.profileBinding.profileRevision !== policy.profileBinding.profileRevision)
    )
      return decision('profile_change');
    if (normalized?.contextGrant && !sameGrant(normalized.contextGrant, policy.contextGrant))
      return decision('grant_change');
    if (normalized?.authorityGrant && !sameGrant(normalized.authorityGrant, policy.authorityGrant))
      return decision('grant_change');
    if (normalized?.selection && normalized.selection.accountId !== policy.primary.accountId)
      return decision('account_change');
  }
  const effective = canonicalOverrides.find((entry) => entry.value?.selection);
  const policyPrimary = policy.primary;
  const requested = effective?.value?.selection ?? policyPrimary;
  let actual: ExecutionSelection = requested;
  let substitutionReason: string | null = null;
  if (actual.accountId !== policyPrimary.accountId) return decision('account_change');
  const matchingAlternative = policy.alternatives.find((candidate) =>
    sameSelection(
      {
        accountId: candidate.accountId,
        model: candidate.model,
        reasoningEffort: candidate.reasoningEffort,
      },
      actual,
    ),
  );
  if (effective && !sameSelection(actual, policyPrimary)) {
    if (!matchingAlternative || (mode !== 'primary' && mode !== matchingAlternative.mode))
      return decision('substitution_unapproved');
    mode = matchingAlternative.mode;
    substitutionReason = matchingAlternative.reason;
  } else if (mode !== 'primary') {
    const candidate = policy.alternatives.find((alternative) => alternative.mode === mode);
    if (!candidate) return decision('substitution_unapproved');
    actual = {
      accountId: candidate.accountId,
      model: candidate.model,
      reasoningEffort: candidate.reasoningEffort,
    };
    substitutionReason = candidate.reason;
  }
  if (actual.accountId !== policyPrimary.accountId) return decision('account_change');
  if (
    usage.data.attempts >= policy.limits.maxAttempts ||
    usage.data.tokens >= policy.limits.maxTokens ||
    usage.data.replans > policy.limits.maxReplans ||
    (mode === 'fallback' && usage.data.fallbacks >= policy.limits.maxFallbacks) ||
    (mode === 'escalation' && usage.data.escalations >= policy.limits.maxEscalations) ||
    (policy.limits.maxCostUsd !== null && usage.data.costUsd >= policy.limits.maxCostUsd)
  )
    return decision('budget_exceeded');

  let catalog: ReturnType<Input['accountProfiles']['catalog']>;
  try {
    catalog = input.accountProfiles.catalog();
  } catch {
    return decision('model_unavailable');
  }
  const account = catalog.find((entry) => entry.id === actual.accountId);
  const model = account?.models.find((entry) => entry.id === actual.model);
  if (!model) return decision('model_unavailable');
  if (actual.reasoningEffort && !model.reasoningEfforts?.includes(actual.reasoningEffort)) {
    return decision('effort_unavailable');
  }
  let binding: AccountBinding;
  try {
    binding = input.accountProfiles.resolve(actual.accountId, actual.model);
    input.accountProfiles.validateModel(binding, actual.model, actual.reasoningEffort);
  } catch {
    return decision('model_unavailable');
  }
  let capabilities: Capability;
  try {
    capabilities = input.capabilities(binding);
  } catch {
    return decision('capability_unavailable');
  }
  if (
    !capabilities?.route ||
    (policy.requiredCapabilities.tools && !capabilities.tools) ||
    (policy.requiredCapabilities.context && !capabilities.context)
  )
    return decision('capability_unavailable');
  let price: Price;
  try {
    price = input.pricing(binding);
  } catch {
    price = { kind: 'unknown' };
  }
  if (!price || (price.kind !== 'known' && price.kind !== 'unknown')) price = { kind: 'unknown' };
  if (
    price.kind === 'known' &&
    (!Number.isFinite(price.maxUsdPerMillionTokens) || price.maxUsdPerMillionTokens < 0)
  ) {
    price = { kind: 'unknown' };
  }
  if (
    price.kind === 'unknown' &&
    policy.limits.maxCostUsd !== null &&
    policy.limits.unknownCostPolicy === 'decision'
  ) {
    return decision('unknown_price');
  }
  if (
    price.kind === 'known' &&
    policy.limits.maxCostUsd !== null &&
    usage.data.costUsd + (policy.limits.maxTokens * price.maxUsdPerMillionTokens) / 1_000_000 >
      policy.limits.maxCostUsd
  ) {
    return decision('budget_exceeded');
  }
  const audit: SelectionAudit = {
    role: policy.role,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    profileBinding: policy.profileBinding,
    policyPrimary,
    requested,
    actual,
    requestedMode: mode,
    overrideSource: effective?.source ?? 'role',
    substitutionReason,
    accountBinding: binding,
    contextGrant: policy.contextGrant,
    authorityGrant: policy.authorityGrant,
    price,
  };
  return {
    kind: 'selected',
    audit,
    workOrderPins: {
      role: policy.role,
      policyRevision: policy.revision,
      accountBinding: binding,
      reasoningEffort: actual.reasoningEffort,
      contextGrant: policy.contextGrant,
      authorityGrant: policy.authorityGrant,
      budget: {
        maxAttempts: policy.limits.maxAttempts,
        maxTokens: policy.limits.maxTokens,
        maxCostUsd: policy.limits.maxCostUsd,
      },
    },
  };
}
