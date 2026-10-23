import { z } from 'zod';
import { CollaborationSettingsSchema } from './collaboration-conversation.js';
import { OrdinaryWorkspaceSettingsSchema } from './ordinary-workspace.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
/** Private application allocation proof. A prepared session has no provider thread or command. */
export const OrdinarySessionPreparationReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    allocationOperationId: id,
    sessionId: id,
    workspaceId: id,
    settings: CollaborationSettingsSchema,
    preparationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    firstCommandId: id.nullable(),
    /** Host-only S5 intent fence, committed atomically before role/task linkage. */
    delegationAttemptId: id.optional(),
  })
  .refine(
    (receipt) =>
      receipt.sessionId !== receipt.workspaceId &&
      receipt.workspaceId === receipt.settings.repositoryWorkspaceId &&
      receipt.settings.binding.harness.implementation === 'codex' &&
      ['local', 'openshell'].includes(receipt.settings.binding.execution.location) &&
      receipt.settings.selection.context.source === 'none',
    'Silent preparation requires distinct identities and an ordinary Codex route without a context recipe',
  );
export type OrdinarySessionPreparationReceipt = z.infer<
  typeof OrdinarySessionPreparationReceiptSchema
>;

/** Separate ordinary kind; V1 repository receipt normalization stays unchanged. */
export const OrdinarySessionPreparationReceiptV2Schema = z
  .strictObject({
    version: z.literal(2),
    allocationOperationId: id,
    sessionId: id,
    workspaceKind: z.literal('ordinary'),
    workspaceId: z.uuid(),
    settings: OrdinaryWorkspaceSettingsSchema,
    preparationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    firstCommandId: id.nullable(),
    delegationAttemptId: id.optional(),
  })
  .refine(
    (receipt) =>
      receipt.workspaceId !== receipt.sessionId &&
      receipt.workspaceId !== receipt.settings.workspace.preparationId &&
      (receipt.settings.binding.execution.location === 'local'
        ? receipt.settings.binding.account.provider === 'openai-codex'
        : ['openai', 'openai-codex'].includes(receipt.settings.binding.account.provider)) &&
      receipt.settings.binding.harness.implementation === 'codex' &&
      receipt.settings.selection.context.source === 'none' &&
      receipt.settings.selection.permission.revision === 0,
    'An ordinary preparation requires distinct identities and the supported Codex route',
  );
export type OrdinarySessionPreparationReceiptV2 = z.infer<
  typeof OrdinarySessionPreparationReceiptV2Schema
>;
