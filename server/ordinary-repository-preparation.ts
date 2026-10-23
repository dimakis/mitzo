import { createHash } from 'node:crypto';
import { CollaborationSettingsSchema } from '@mitzo/protocol';
import {
  AccountBindingSchema,
  SessionRuntimeBindingV2Schema,
  OrdinaryOpenShellCommandAdmissionSchema,
} from '@mitzo/protocol';
import { z } from 'zod';

/** Intent only; the server resolves every identity and captures private source proof. */
export const OrdinaryRepositoryRuntimeSelectionSchema = z.strictObject({
  runOn: z.enum(['local', 'openshell']),
  runtime: z.strictObject({
    account: SessionRuntimeBindingV2Schema.shape.account,
    harness: z.enum(['codex', 'responses', 'claude-sdk', 'gemini']),
    targetId: z.string().min(1).max(200).regex(/^\S+$/),
  }),
});
export type OrdinaryRepositoryRuntimeSelection = z.infer<
  typeof OrdinaryRepositoryRuntimeSelectionSchema
>;
/** Private existing preparation-row custody. Original model is never rewritten. */
export const OrdinaryRepositoryPreparationSchema = z.strictObject({
  version: z.literal(1),
  originalBinding: AccountBindingSchema,
  runtimeBinding: SessionRuntimeBindingV2Schema,
  sandboxWorkdir: OrdinaryOpenShellCommandAdmissionSchema.shape.workspace.shape.cwd.optional(),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
  credentialDigestVersion: z.literal(2).optional(),
  sourceIdentity: z
    .strictObject({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() })
    .optional(),
});
export type OrdinaryRepositoryPreparation = z.infer<typeof OrdinaryRepositoryPreparationSchema>;

/** Exact silent-allocation selection. Queue-creating API/SDK adapters are excluded. */
export const OrdinarySilentPreparationSelectionSchema = CollaborationSettingsSchema.refine(
  (value) =>
    value.binding.harness.implementation === 'codex' &&
    ['local', 'openshell'].includes(value.binding.execution.location) &&
    value.selection.context.source === 'none',
  'Silent ordinary preparation is unavailable for this route or context recipe',
);
export function ordinaryPreparationFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
