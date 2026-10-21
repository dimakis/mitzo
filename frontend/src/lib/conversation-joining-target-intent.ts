import { z } from 'zod';
import { SessionCollaborationIdSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { ChatDraftSchema } from './chat-drafts';

/** Existing ordinary repository preview wire shape, kept browser-only like
 * RepositoryChatPicker. The server resolves access, source custody and readiness. */
const ordinaryRuntime = z.strictObject({
  runOn: z.enum(['local', 'openshell']),
  runtime: z.strictObject({
    account: SessionRuntimeBindingV2Schema.shape.account,
    harness: SessionRuntimeBindingV2Schema.shape.harness.shape.implementation,
    targetId: SessionRuntimeBindingV2Schema.shape.execution.shape.targetId,
  }),
});
export const ConversationJoiningPreviewIntentSchema = z.strictObject({
  requestId: z.uuid(),
  accountId: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128),
  repository: z.string().min(3).max(256),
  ordinaryRuntime,
});
const emptyDraft = ChatDraftSchema.strict()
  .extend({
    id: z.uuid(),
    settings: ChatDraftSchema.shape.settings.strict(),
  })
  .refine(
    (draft) =>
      draft.text === '' &&
      !draft.images.length &&
      !draft.contextBlocks.length &&
      !draft.settings.launch &&
      !draft.settings.sourceSnapshots &&
      !draft.settings.collaborationResponders &&
      draft.settings.summary === null &&
      draft.settings.retainRuntimeIntent === true &&
      !!draft.settings.runtimeSelection &&
      !!draft.settings.runtimeSelection.agentProfile,
    'Only fresh ordinary target correlation can be retained',
  );

/** Public intent and operation phase only. Even resolved requires a fresh
 * qualified GET; no capacity, native witness or execution permission persists. */
export const ConversationJoiningTargetIntentSchema = z
  .strictObject({
    collaborationId: SessionCollaborationIdSchema,
    reviewRequestId: z.uuid(),
    phase: z.enum(['preview_pending', 'previewed', 'prepare_pending', 'resolved']),
    preview: ConversationJoiningPreviewIntentSchema,
    draft: emptyDraft,
  })
  .superRefine((value, context) => {
    const { draft, preview } = value;
    const runtime = draft.settings.runtimeSelection;
    if (
      draft.id === preview.requestId ||
      draft.settings.repositoryWorkspaceId !== preview.requestId ||
      draft.settings.selection?.accountId !== preview.accountId ||
      draft.settings.selection.model !== preview.model ||
      runtime?.account?.accountId !== preview.accountId ||
      runtime.account.model !== preview.model ||
      runtime.execution.location !== preview.ordinaryRuntime.runOn ||
      runtime.execution.targetId !== preview.ordinaryRuntime.runtime.targetId ||
      runtime.accountReference?.accountId !== preview.ordinaryRuntime.runtime.account.accountId ||
      runtime.accountReference?.provider !== preview.ordinaryRuntime.runtime.account.provider ||
      runtime.accountReference?.profileRevision !==
        preview.ordinaryRuntime.runtime.account.profileRevision
    )
      context.addIssue({ code: 'custom', message: 'Original fresh target intent conflicts' });
  });
export type ConversationJoiningTargetIntent = z.infer<typeof ConversationJoiningTargetIntentSchema>;

export class ConversationJoiningTargetError extends Error {}
