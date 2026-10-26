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
  historicalStateUnavailable: z.boolean().optional(),
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

const LinkIdentity = z.object({
  reviewHash: z.string(),
  sourceSessionId: z.string(),
  nativeSessionId: z.string(),
  commandId: z.string(),
});
const Lineage = z.object({
  links: z.array(
    LinkIdentity.extend({
      state: z.enum(['reviewed', 'uncertain', 'consumed', 'discarded']),
      canReviewAgain: z.boolean().optional(),
    }),
  ),
});
function matchesReview(
  link: z.infer<typeof LinkIdentity>,
  sourceSessionId: string,
  review: ReviewIdentity,
) {
  return (
    link.reviewHash === review.reviewHash &&
    link.sourceSessionId === sourceSessionId &&
    link.nativeSessionId === review.nativeSessionId &&
    link.commandId === review.commandId
  );
}
/** Read-only evidence can offer recovery; retiring the old review is a separate
 * atomic owner operation before any picker or new-command identity is unlocked. */
export async function canReviewNativeContinuationAgain(
  sourceSessionId: string,
  review: ReviewIdentity,
) {
  const response = await apiFetch(
    `/api/sessions/${encodeURIComponent(sourceSessionId)}/native-continuation`,
  );
  if (!response.ok) return false;
  const parsed = Lineage.safeParse(await response.json());
  if (!parsed.success) return false;
  const exact = parsed.data.links.filter((link) => matchesReview(link, sourceSessionId, review));
  return (
    exact.length === 1 &&
    exact[0].canReviewAgain === true &&
    ['reviewed', 'discarded'].includes(exact[0].state)
  );
}
export async function discardUnclaimedNativeContinuation(
  sourceSessionId: string,
  review: ReviewIdentity,
) {
  const response = await apiFetch(
    `/api/sessions/${encodeURIComponent(sourceSessionId)}/native-continuation/discard`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewHash: review.reviewHash }),
    },
  );
  if (!response.ok)
    throw Error(
      'The original command may be claimed or uncertain. Check its admission before reviewing another attempt.',
    );
  const receipt = LinkIdentity.extend({ state: z.literal('discarded') }).parse(
    await response.json(),
  );
  if (!matchesReview(receipt, sourceSessionId, review))
    throw Error('Discarded native review identity changed');
}
