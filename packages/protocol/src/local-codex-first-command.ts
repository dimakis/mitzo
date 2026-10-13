import { z } from 'zod';
import { OrdinaryLocalCommandSelectionSchema } from './ordinary-local-admission.js';
import { AgentProfileSelectionSchema } from './agent-library.js';
import { SessionRuntimeBindingV1Schema } from './session-runtime-binding.js';
const reference = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
function validateCommandBounds(
  request: { runtime: { mode: string }; selection: { permission: { mode: string } } },
  ctx: z.RefinementCtx,
) {
  if (request.runtime.mode !== request.selection.permission.mode)
    ctx.addIssue({ code: 'custom', message: 'Permission selection mismatch' });
  if (new TextEncoder().encode(JSON.stringify(request)).length > 1048576)
    ctx.addIssue({ code: 'custom', message: 'Command exceeds bound' });
}
/** Client intent only. The server derives workspace, prompt and owning authority. */
export const LocalCodexFirstCommandSchema = z
  .strictObject({
    runOn: z.literal('local'),
    repositoryWorkspaceId: z.uuid(),
    clientMsgId: reference,
    capabilityRevision: reference,
    runtime: z.strictObject({
      account: SessionRuntimeBindingV1Schema.shape.account
        .extend({ provider: z.literal('openai-codex') })
        .strict(),
      harness: z.literal('codex'),
      targetId: reference,
      mode: z.enum(['ask', 'agent', 'auto']),
    }),
    selection: OrdinaryLocalCommandSelectionSchema.extend({
      // Namespace/recipe intent is frozen here; owning admission verifies its source and delivery.
      agent: AgentProfileSelectionSchema,
      context: OrdinaryLocalCommandSelectionSchema.shape.context,
      permission: z.strictObject({
        mode: z.enum(['ask', 'agent', 'auto']),
        revision: z.literal(0),
      }),
    }).strict(),
    payload: z.strictObject({
      text: z.string().min(1).max(1_000_000),
      intent: z.string().max(1_000_000).optional(),
      images: z
        .array(
          z.strictObject({
            data: z
              .string()
              .min(1)
              .max(14_000_000)
              .refine((data) => {
                if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
                const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
                if (data.endsWith('==')) return (alphabet.indexOf(data.at(-3)!) & 15) === 0;
                if (data.endsWith('=')) return (alphabet.indexOf(data.at(-2)!) & 3) === 0;
                return true;
              }, 'Invalid canonical base64'),
            mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
          }),
        )
        .max(10)
        .optional(),
    }),
  })
  .superRefine(validateCommandBounds);
export type LocalCodexFirstCommand = z.infer<typeof LocalCodexFirstCommandSchema>;
/** Future-message intent retains the original prepared repository and binding.
 * Admission verifies both identities; this cannot enroll or switch a session.
 */
export const LocalCodexContinuationCommandSchema = LocalCodexFirstCommandSchema.safeExtend({
  sessionId: reference,
});
export type LocalCodexContinuationCommand = z.infer<typeof LocalCodexContinuationCommandSchema>;
/** Shared picker intent for the enrolled ordinary Codex adapters. Software and
 * target compatibility are resolved by server owners before any effects.
 */
export const OrdinaryCodexFirstCommandSchema = z
  .strictObject({
    ...LocalCodexFirstCommandSchema.shape,
    runOn: z.enum(['local', 'openshell']),
    runtime: z.strictObject({
      ...LocalCodexFirstCommandSchema.shape.runtime.shape,
      account: z.strictObject({
        ...LocalCodexFirstCommandSchema.shape.runtime.shape.account.shape,
        provider: z.enum(['openai-codex', 'openai']),
      }),
    }),
  })
  .superRefine((request, ctx) => {
    validateCommandBounds(request, ctx);
    if (request.runOn === 'local' && request.runtime.account.provider !== 'openai-codex')
      ctx.addIssue({ code: 'custom', message: 'Unsupported Local account adapter' });
  });
export type OrdinaryCodexFirstCommand = z.infer<typeof OrdinaryCodexFirstCommandSchema>;
export const OrdinaryCodexContinuationCommandSchema = OrdinaryCodexFirstCommandSchema.safeExtend({
  sessionId: reference,
});
export type OrdinaryCodexContinuationCommand = z.infer<
  typeof OrdinaryCodexContinuationCommandSchema
>;
export const LocalCodexFirstCommandReceiptSchema = z.strictObject({
  ok: z.literal(true),
  clientMsgId: reference,
  sessionId: reference,
  dispatched: z.boolean(),
  state: z.enum(['reserved', 'uncertain', 'consumed']),
});
export type LocalCodexFirstCommandReceipt = z.infer<typeof LocalCodexFirstCommandReceiptSchema>;
/** A retained receipt observation is not acknowledgement of this submitted request. */
export const LocalCodexRetainedCommandObservationSchema = z.strictObject({
  ok: z.literal(false),
  code: z.literal('retained_command'),
  error: z.literal('Local Codex entry unavailable'),
  clientMsgId: reference,
  sessionId: reference,
  state: z.enum(['reserved', 'uncertain', 'consumed']),
});

/** Generic runtime entry retains the same receipt semantics and route-specific reasons. */
export const OrdinaryCodexRetainedCommandObservationSchema =
  LocalCodexRetainedCommandObservationSchema.extend({
    error: z.enum(['Local Codex entry unavailable', 'Conversation runtime unavailable']),
  });
