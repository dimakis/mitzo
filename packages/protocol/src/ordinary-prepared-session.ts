import { z } from 'zod';
import { CollaborationSettingsSchema } from './collaboration-conversation.js';

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
