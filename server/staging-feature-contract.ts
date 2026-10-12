import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const StagingFeatureRequest = z.strictObject({
  version: z.literal(2),
  id,
  pr: z.number().int().positive(),
  taskId: id,
  acceptedCommit: commit,
  suite: z.literal('profile-tools-v1'),
  profileId: id,
  enrollmentRevision: sha,
});
export const StagingFeatureToken = z.strictObject({
  epoch: z.number().int().positive(),
  requestId: id,
  owner: id,
  nonce: id,
});
const modelOrAccount = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/);
export const StagingAcceptedAppSource = z.strictObject({
  nativeSourceCommit: commit,
  acceptedAppCommit: commit,
  appRoot: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/')),
  instanceId: id,
  custodianPid: z.number().int().positive(),
  epoch: z.number().int().positive(),
  controllerPid: z.number().int().positive(),
  compatibilitySha256: sha,
});
export const StagingFeaturePlan = z
  .strictObject({
    version: z.literal(1),
    requestId: id,
    sourceCommit: commit,
    nativeSourceCommit: commit.optional(),
    acceptedAppSource: StagingAcceptedAppSource.optional(),
    profileId: id,
    enrollmentRevision: sha,
    profileRevision: sha,
    provider: id,
    runtime: id,
    runtimeRevision: sha,
    ownerInstance: id,
    chargedAccount: modelOrAccount,
    selectedModel: modelOrAccount,
    modelApprovalId: id.nullable(),
    suite: z.literal('profile-tools-v1'),
    suiteRevision: sha,
    runnerRevision: sha,
    modelDispatches: z.tuple([
      z.strictObject({
        purpose: z.enum(['main', 'all-inference']),
        chargedAccount: modelOrAccount,
        selectedModel: modelOrAccount,
        maxModelRounds: z.literal(2),
      }),
    ]),
    auxiliaryDispatches: z.enum(['disabled', 'same-selected-model-shared-budget']),
    limits: z.strictObject({
      maxProviderDispatches: z.literal(1),
      timeoutMs: z.number().int().min(1000).max(180000),
      maxOutputBytes: z.number().int().positive().max(65536),
    }),
  })
  .superRefine((plan, context) => {
    const scope = plan.modelDispatches[0];
    if (
      scope.chargedAccount !== plan.chargedAccount ||
      scope.selectedModel !== plan.selectedModel ||
      (plan.auxiliaryDispatches === 'disabled'
        ? scope.purpose !== 'main'
        : scope.purpose !== 'all-inference' || plan.runtime !== 'openshell-native')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exact shared inference scope required',
      });
    if (
      !/^gpt-\d+(?:\.\d+)?-luna$/.test(plan.selectedModel) &&
      !(
        plan.provider === 'anthropic-vertex' &&
        plan.selectedModel === 'claude-haiku-4-5@20251001' &&
        plan.modelApprovalId
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supported Luna or exact authenticated Vertex Haiku approval required',
      });
    if (
      Boolean(plan.nativeSourceCommit) !== Boolean(plan.acceptedAppSource) ||
      (plan.acceptedAppSource &&
        (plan.runtime !== 'openshell-native' ||
          plan.acceptedAppSource.nativeSourceCommit !== plan.nativeSourceCommit ||
          plan.acceptedAppSource.acceptedAppCommit !== plan.sourceCommit ||
          plan.acceptedAppSource.instanceId !== plan.ownerInstance))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Paired native/accepted app source observations required',
      });
  });
export type StagingFeaturePlanValue = z.infer<typeof StagingFeaturePlan>;
