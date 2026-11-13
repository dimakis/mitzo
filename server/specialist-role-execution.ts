import type { SpecialistPolicy, ConsultationRecord } from './specialist-consultation-contract.js';
import type { AccountProfiles } from './account-profiles.js';
import { resolveRoleExecution } from './model-routing-policy.js';

/** Translate an exact operator-approved collaboration policy into the existing
 * role resolver. Its references identify this policy, never source/tool grants.
 * Actual source, runtime and command admission still renew their own authority. */
export function specialistRoleExecution(
  policy: SpecialistPolicy,
  record: ConsultationRecord,
  profiles: AccountProfiles,
) {
  const route = record.route;
  return resolveRoleExecution({
    policy: {
      version: 1,
      policyId: policy.policyId,
      revision: '1',
      role: route.role,
      profileBinding: {
        profileId: route.agent.profileId,
        profileRevision: `${route.agent.revision}:${route.profileHash}`,
      },
      primary: {
        accountId: route.accountId,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      },
      alternatives: [],
      contextGrant: { grantId: policy.policyId, revision: 1 },
      authorityGrant: { grantId: policy.policyId, revision: 1 },
      requiredCapabilities: { route: true, context: true, tools: false },
      limits: {
        maxAttempts: policy.maxConsultations,
        // The collaboration policy caps calls and selected context bytes. It
        // deliberately does not advertise a total-token or dollar budget.
        maxTokens: Number.MAX_SAFE_INTEGER,
        maxCostUsd: null,
        maxReplans: 0,
        maxFallbacks: 0,
        maxEscalations: 0,
        unknownCostPolicy: 'decision',
      },
    },
    accountProfiles: profiles,
    capabilities: () => ({ route: true, context: true, tools: false }),
    pricing: () => ({ kind: 'unknown' }),
    usage: {
      attempts: record.attemptOrdinal,
      tokens: 0,
      costUsd: 0,
      replans: 0,
      fallbacks: 0,
      escalations: 0,
    },
  });
}
