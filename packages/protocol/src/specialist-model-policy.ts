import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
export const SpecialistAllowanceSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const SpecialistAllowanceEditSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  maxConsultations: SpecialistAllowanceSchema,
});
export const SpecialistAllowanceSummarySchema = z.strictObject({
  policyId: z.uuid(),
  revision: z.number().int().nonnegative(),
  maxConsultations: SpecialistAllowanceSchema,
  roles: z.array(z.string()),
  expiresAt: z.number(),
});
export const SpecialistModelRuleSchema = z.strictObject({
  accountId: id,
  model: id,
  admission: z.enum(['ask', 'auto', 'off']),
  allowance: SpecialistAllowanceSchema,
});
export const SpecialistModelPolicySchema = z
  .strictObject({
    models: z.array(SpecialistModelRuleSchema).max(200),
  })
  .refine(
    ({ models }) =>
      new Set(models.map((rule) => JSON.stringify([rule.accountId, rule.model]))).size ===
      models.length,
    'Each account/model must have exactly one policy',
  );
export const SpecialistModelPolicySaveSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  policy: SpecialistModelPolicySchema.nullable(),
});
export const SpecialistModelPolicyVersionSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  policy: SpecialistModelPolicySchema.nullable(),
});
export const SpecialistModelPolicyViewSchema = z.strictObject({
  workspace: SpecialistModelPolicyVersionSchema,
  conversation: SpecialistModelPolicyVersionSchema,
});
export type SpecialistModelPolicy = z.infer<typeof SpecialistModelPolicySchema>;
export type SpecialistModelPolicyView = z.infer<typeof SpecialistModelPolicyViewSchema>;
export type SpecialistModelPolicySave = z.infer<typeof SpecialistModelPolicySaveSchema>;
