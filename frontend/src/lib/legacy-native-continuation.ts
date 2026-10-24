import { z } from 'zod';
import { OrdinaryCodexFirstCommandSchema, SessionRuntimeBindingV1Schema } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';

export const NativeContinuationReviewSchema = z.object({
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSessionId: z.string().min(1).max(200),
  nativeSessionId: z.string().min(1).max(200),
  commandId: z.string().min(1).max(200),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  account: SessionRuntimeBindingV1Schema.shape.account,
  sourceSelection: z.object({
    model: z.string(),
    thinking: z.string().nullable(),
    mode: z.string(),
    targetId: z.string().nullable(),
  }),
  command: OrdinaryCodexFirstCommandSchema,
  uncertainOutcomes: z.boolean(),
  selectionChanged: z.boolean(),
  retainedPendingCommands: z.number().int().nonnegative(),
  omittedNonTextBlocks: z.number().int().nonnegative(),
  omittedEarlierCharacters: z.number().int().nonnegative(),
  context: z.string().max(48000),
});
export type NativeContinuationReview = z.infer<typeof NativeContinuationReviewSchema>;
const Receipt = z.object({
  ok: z.boolean(),
  sessionId: z.string(),
  clientMsgId: z.string(),
  state: z.enum(['reserved', 'uncertain', 'consumed']),
  dispatched: z.boolean(),
});
type ReviewIdentity = Pick<
  NativeContinuationReview,
  'reviewHash' | 'nativeSessionId' | 'commandId'
>;

export async function commitNativeContinuation(
  sourceSessionId: string,
  review: ReviewIdentity,
  connectionId: string,
  acknowledgeUncertainOutcomes: boolean,
  acknowledgeSelectionChange: boolean,
) {
  const response = await apiFetch(
    `/api/sessions/${encodeURIComponent(sourceSessionId)}/native-continuation/commit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Id': connectionId },
      body: JSON.stringify({
        reviewHash: review.reviewHash,
        acknowledgeUncertainOutcomes,
        acknowledgeSelectionChange,
      }),
    },
  );
  const raw = await response.json();
  if (!response.ok)
    throw Error(
      'Native continuation admission is unconfirmed. Check the original review again; no fresh command will be sent.',
    );
  const receipt = Receipt.parse(raw);
  if (receipt.sessionId !== review.nativeSessionId || receipt.clientMsgId !== review.commandId)
    throw Error('Native continuation receipt identity changed');
  return receipt;
}
