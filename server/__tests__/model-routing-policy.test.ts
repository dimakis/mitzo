import { describe, expect, it } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { resolveRoleExecution } from '../model-routing-policy.js';
import { ExecutionPolicySchema, WorkOrderSchema } from '@mitzo/protocol';

const accounts = new AccountProfiles([
  {
    id: 'work',
    label: 'Work',
    provider: 'anthropic-vertex',
    projectId: 'p',
    region: 'r',
    credentialRef: '/tmp/work-adc',
    models: [
      { id: 'planner', label: 'Planner', reasoningEfforts: ['high'] },
      { id: 'coder', label: 'Coder', reasoningEfforts: ['medium'] },
      { id: 'reviewer', label: 'Reviewer', reasoningEfforts: ['high'] },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    provider: 'google-vertex',
    projectId: 'p2',
    region: 'r',
    credentialRef: '/tmp/other-adc',
    models: [{ id: 'coder', label: 'Coder' }],
  },
]);
const ref = { grantId: 'g', revision: 2 };
const selection = (model: string, reasoningEffort: string) => ({
  accountId: 'work',
  model,
  reasoningEffort,
});
const policy = (role: string, model: string, effort: string) =>
  ExecutionPolicySchema.parse({
    version: 1,
    policyId: `${role}-policy`,
    revision: 'r2',
    role,
    profileBinding: { profileId: `${role}-profile`, profileRevision: 'p3' },
    primary: selection(model, effort),
    alternatives: [
      { mode: 'fallback', ...selection('coder', 'medium'), reason: 'Primary unavailable' },
    ],
    contextGrant: ref,
    authorityGrant: { grantId: 'a', revision: 3 },
    requiredCapabilities: { tools: true, context: true, route: true },
    limits: {
      maxAttempts: 3,
      maxTokens: 1000,
      maxCostUsd: 1,
      maxReplans: 1,
      maxFallbacks: 1,
      maxEscalations: 0,
      unknownCostPolicy: 'decision',
    },
  });
const base = {
  accountProfiles: accounts,
  capabilities: () => ({ tools: true, context: true, route: true }),
  pricing: () => ({ kind: 'known' as const, maxUsdPerMillionTokens: 10 }),
  usage: { attempts: 0, tokens: 0, costUsd: 0, replans: 0, fallbacks: 0, escalations: 0 },
};

describe('role execution policy', () => {
  it('selects distinct planner, coder and reviewer bindings with work-order pins', () => {
    for (const [role, model, effort] of [
      ['architect', 'planner', 'high'],
      ['implementer', 'coder', 'medium'],
      ['reviewer', 'reviewer', 'high'],
    ]) {
      const result = resolveRoleExecution({ ...base, policy: policy(role, model, effort) });
      expect(result.kind).toBe('selected');
      if (result.kind !== 'selected') continue;
      expect(result.audit).toMatchObject({
        role,
        policyRevision: 'r2',
        requested: selection(model, effort),
        actual: selection(model, effort),
      });
      expect(
        WorkOrderSchema.shape.accountBinding.parse(result.workOrderPins.accountBinding).model,
      ).toBe(model);
      expect(result.workOrderPins).toMatchObject({
        policyRevision: 'r2',
        contextGrant: ref,
      });
      expect(result.audit.profileBinding).toEqual({
        profileId: `${role}-profile`,
        profileRevision: 'p3',
      });
    }
  });
  it('uses seat then task then goal override, and rejects account or grant expansion', () => {
    const p = policy('architect', 'planner', 'high');
    const overrides = {
      goal: { selection: selection('coder', 'medium') },
      task: { selection: selection('reviewer', 'high') },
      seat: { selection: selection('planner', 'high') },
    };
    const result = resolveRoleExecution({ ...base, policy: p, overrides });
    expect(result).toMatchObject({
      kind: 'selected',
      audit: { overrideSource: 'seat', actual: selection('planner', 'high') },
    });
    const taskWins = resolveRoleExecution({
      ...base,
      policy: p,
      overrides: {
        goal: { selection: selection('planner', 'high') },
        task: { selection: selection('coder', 'medium') },
      },
    });
    expect(taskWins).toMatchObject({
      kind: 'selected',
      audit: {
        overrideSource: 'task',
        policyPrimary: selection('planner', 'high'),
        requested: selection('coder', 'medium'),
        actual: selection('coder', 'medium'),
        requestedMode: 'fallback',
        substitutionReason: 'Primary unavailable',
      },
    });
    expect(
      resolveRoleExecution({
        ...base,
        policy: p,
        overrides: { task: { selection: selection('coder', 'medium') } },
        usage: { ...base.usage, fallbacks: 1 },
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'budget_exceeded' });
    expect(
      resolveRoleExecution({
        ...base,
        policy: p,
        overrides: {
          task: { selection: { accountId: 'other', model: 'coder', reasoningEffort: null } },
        },
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'account_change' });
    expect(
      resolveRoleExecution({
        ...base,
        policy: p,
        overrides: { seat: { authorityGrant: { grantId: 'a', revision: 4 } } },
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'grant_change' });
  });
  it('requires a decision for unsupported model or effort and does not leak provider errors', () => {
    expect(
      resolveRoleExecution({ ...base, policy: policy('architect', 'missing', 'high') }),
    ).toMatchObject({ kind: 'decision_required', code: 'model_unavailable' });
    const p = policy('architect', 'planner', 'low');
    expect(resolveRoleExecution({ ...base, policy: p })).toMatchObject({
      kind: 'decision_required',
      code: 'effort_unavailable',
    });
    const error = resolveRoleExecution({
      ...base,
      policy: policy('architect', 'planner', 'high'),
      capabilities: () => {
        throw new Error('credential secret=abc');
      },
    });
    expect(error).toMatchObject({ kind: 'decision_required', code: 'capability_unavailable' });
    expect(JSON.stringify(error)).not.toContain('secret=abc');
  });
  it('records preauthorized fallback substitution and refuses unapproved escalation or account switch', () => {
    const p = policy('architect', 'planner', 'high');
    const result = resolveRoleExecution({ ...base, policy: p, requestedMode: 'fallback' });
    expect(result).toMatchObject({
      kind: 'selected',
      audit: {
        requested: selection('planner', 'high'),
        actual: selection('coder', 'medium'),
        substitutionReason: 'Primary unavailable',
      },
    });
    expect(resolveRoleExecution({ ...base, policy: p, requestedMode: 'escalation' })).toMatchObject(
      { kind: 'decision_required', code: 'substitution_unapproved' },
    );
    expect(
      resolveRoleExecution({
        ...base,
        policy: p,
        requestedMode: 'fallback',
        usage: { ...base.usage, fallbacks: 1 },
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'budget_exceeded' });
  });
  it('uses the requested mode when two alternatives select the same model', () => {
    const p = policy('architect', 'planner', 'high');
    const duplicate = {
      ...p,
      alternatives: [
        ...p.alternatives,
        {
          mode: 'escalation' as const,
          ...selection('coder', 'medium'),
          reason: 'Explicit escalation',
        },
      ],
      limits: { ...p.limits, maxEscalations: 1 },
    };
    const override = { seat: { selection: selection('coder', 'medium') } };
    expect(
      resolveRoleExecution({
        ...base,
        policy: duplicate,
        requestedMode: 'escalation',
        overrides: override,
      }),
    ).toMatchObject({
      kind: 'selected',
      audit: {
        requestedMode: 'escalation',
        substitutionReason: 'Explicit escalation',
      },
    });
    expect(
      resolveRoleExecution({
        ...base,
        policy: duplicate,
        requestedMode: 'escalation',
        overrides: override,
        usage: { ...base.usage, escalations: 1 },
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'budget_exceeded' });
    expect(resolveRoleExecution({ ...base, policy: duplicate, overrides: override })).toMatchObject(
      { kind: 'decision_required', code: 'substitution_unapproved' },
    );
  });
  it('enforces attempt, token and cost caps and treats unknown price explicitly', () => {
    const p = policy('architect', 'planner', 'high');
    expect(
      resolveRoleExecution({ ...base, policy: p, usage: { ...base.usage, attempts: 3 } }),
    ).toMatchObject({ kind: 'decision_required', code: 'budget_exceeded' });
    expect(
      resolveRoleExecution({ ...base, policy: p, usage: { ...base.usage, tokens: 1000 } }),
    ).toMatchObject({ kind: 'decision_required', code: 'budget_exceeded' });
    expect(
      resolveRoleExecution({
        ...base,
        policy: p,
        pricing: () => ({ kind: 'known' as const, maxUsdPerMillionTokens: 2000 }),
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'budget_exceeded' });
    expect(
      resolveRoleExecution({ ...base, policy: p, pricing: () => ({ kind: 'unknown' as const }) }),
    ).toMatchObject({ kind: 'decision_required', code: 'unknown_price' });
    const allowed = resolveRoleExecution({
      ...base,
      policy: { ...p, limits: { ...p.limits, unknownCostPolicy: 'allow_with_token_cap' as const } },
      pricing: () => ({ kind: 'unknown' as const }),
    });
    expect(allowed).toMatchObject({ kind: 'selected', audit: { price: { kind: 'unknown' } } });
    const partial = resolveRoleExecution({
      ...base,
      policy: p,
      usage: { ...base.usage, attempts: 1, tokens: 500, costUsd: 0.5 },
      pricing: () => ({ kind: 'known' as const, maxUsdPerMillionTokens: 1000 }),
    });
    expect(partial).toMatchObject({
      kind: 'selected',
      workOrderPins: {
        budget: { maxAttempts: 2, maxTokens: 500, maxCostUsd: 0.5 },
      },
    });
  });
  it('fails closed on missing runtime route capability', () => {
    expect(
      resolveRoleExecution({
        ...base,
        policy: policy('architect', 'planner', 'high'),
        capabilities: () => ({ tools: true, context: true, route: false }),
      }),
    ).toMatchObject({ kind: 'decision_required', code: 'capability_unavailable' });
  });
  it('rejects incomplete or malformed runtime usage and substitution mode', () => {
    const p = policy('architect', 'planner', 'high');
    for (const usage of [
      {},
      { attempts: 0 },
      { ...base.usage, costUsd: NaN },
      { ...base.usage, attempts: -1 },
      { ...base.usage, tokens: Infinity },
    ]) {
      expect(
        resolveRoleExecution({ ...base, policy: p, usage: usage as typeof base.usage }),
      ).toMatchObject({ kind: 'decision_required', code: 'invalid_policy' });
    }
    expect(
      resolveRoleExecution({ ...base, policy: p, requestedMode: 'unapproved' as 'primary' }),
    ).toMatchObject({ kind: 'decision_required', code: 'invalid_policy' });
  });
  it('compares canonical override fields independent of property order', () => {
    const p = policy('architect', 'planner', 'high');
    const result = resolveRoleExecution({
      ...base,
      policy: p,
      overrides: {
        seat: {
          selection: { reasoningEffort: 'medium', model: 'coder', accountId: 'work' },
          profileBinding: { profileRevision: 'p3', profileId: 'architect-profile' },
          contextGrant: { revision: 2, grantId: 'g' },
          authorityGrant: { revision: 3, grantId: 'a' },
        },
      },
    });
    expect(result).toMatchObject({
      kind: 'selected',
      audit: {
        requested: selection('coder', 'medium'),
        actual: selection('coder', 'medium'),
        overrideSource: 'seat',
      },
    });
  });
});
