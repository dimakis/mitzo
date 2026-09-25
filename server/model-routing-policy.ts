import {
  ExecutionPolicySchema,
  ExecutionOverrideSchema,
  type ExecutionPolicy,
  type ExecutionOverride,
  type ExecutionSelection,
  type AccountBinding,
} from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';

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
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const safeCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** Pure, fail-closed selection. Caller must persist the audit and atomically admit the work order. */
export function resolveRoleExecution(input: Input): Decision | Selected {
  const parsed = ExecutionPolicySchema.safeParse(input.policy);
  if (
    !parsed.success ||
    !Object.entries(input.usage).every(([key, value]) =>
      key === 'costUsd' ? Number.isFinite(value) && value >= 0 : safeCount(value),
    )
  )
    return decision('invalid_policy');
  const policy = parsed.data;
  let mode = input.requestedMode ?? 'primary';
  const overrideEntries = (['seat', 'task', 'goal'] as const).map((source) => ({
    source,
    value: input.overrides?.[source],
  }));
  for (const { value } of overrideEntries) {
    if (value && !ExecutionOverrideSchema.safeParse(value).success)
      return decision('invalid_policy');
    if (value?.profileBinding && !same(value.profileBinding, policy.profileBinding))
      return decision('profile_change');
    if (value?.contextGrant && !same(value.contextGrant, policy.contextGrant))
      return decision('grant_change');
    if (value?.authorityGrant && !same(value.authorityGrant, policy.authorityGrant))
      return decision('grant_change');
    if (value?.selection && value.selection.accountId !== policy.primary.accountId)
      return decision('account_change');
  }
  const effective = overrideEntries.find((entry) => entry.value?.selection);
  const requested = policy.primary;
  let actual: ExecutionSelection = effective?.value?.selection ?? requested;
  let substitutionReason: string | null = null;
  if (actual.accountId !== requested.accountId) return decision('account_change');
  const matchingAlternative = policy.alternatives.find((candidate) =>
    same(
      {
        accountId: candidate.accountId,
        model: candidate.model,
        reasoningEffort: candidate.reasoningEffort,
      },
      actual,
    ),
  );
  if (effective && !same(actual, requested)) {
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
  if (actual.accountId !== requested.accountId) return decision('account_change');
  if (
    input.usage.attempts >= policy.limits.maxAttempts ||
    input.usage.tokens >= policy.limits.maxTokens ||
    input.usage.replans > policy.limits.maxReplans ||
    (mode === 'fallback' && input.usage.fallbacks >= policy.limits.maxFallbacks) ||
    (mode === 'escalation' && input.usage.escalations >= policy.limits.maxEscalations) ||
    (policy.limits.maxCostUsd !== null && input.usage.costUsd >= policy.limits.maxCostUsd)
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
    input.usage.costUsd + (policy.limits.maxTokens * price.maxUsdPerMillionTokens) / 1_000_000 >
      policy.limits.maxCostUsd
  ) {
    return decision('budget_exceeded');
  }
  const audit: SelectionAudit = {
    role: policy.role,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    profileBinding: policy.profileBinding,
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
