import { z } from 'zod';
const reference = z.string().min(1).max(200).regex(/^\S+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const directory = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\/[^\r\n\0]*$/);
/** Bounded private send-ledger projection. This observation is not the server's
 * materialization proof, current operator authority or a filesystem grant. */
export const PreparedRepositoryTransitionSchema = z.strictObject({
  version: z.literal(1),
  preparationId: z.uuid(),
  runtimeId: reference,
  source: z.strictObject({
    commandId: reference,
    attempt: z.number().int().positive().safe(),
    threadId: reference,
    turnId: reference,
    generation: z.number().int().nonnegative().safe(),
    callId: reference,
    requestHash: digest,
    resultSha256: digest,
  }),
  oldWorkspace: z.strictObject({
    kind: z.enum(['ordinary', 'repository']),
    id: reference,
    directory,
  }),
  newWorkspace: z.strictObject({
    kind: z.literal('repository'),
    id: reference,
    directory,
    featureBranch: reference,
    baseOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    taskIdentitySha256: digest,
  }),
  consumedScopeSha256: digest,
  materializedRecordSha256: digest,
});
export type PreparedRepositoryTransition = z.infer<typeof PreparedRepositoryTransitionSchema>;
