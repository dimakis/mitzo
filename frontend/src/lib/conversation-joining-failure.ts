import { CollaborationApiError } from '@mitzo/client';

const refusals: Record<string, string> = {
  execution_unavailable:
    'This agent cannot join with the selected account, model and repository yet. Go Back to check its setup.',
  unavailable_recipient:
    'The source conversation or selected agent is unavailable. Go Back to check its setup.',
  snapshot_changed:
    'The selected context or setup changed. Go Back to review the starting context again.',
  capacity_refused:
    'The selected context is too large. Go Back and choose fewer messages or artifacts.',
  request_conflict:
    'This review differs from the retained request. Your original setup stays here.',
  conflict: 'The conversation changed during review. Your original setup stays here.',
};

/** Never render provider/transport exception text or arbitrary server codes. */
export function conversationJoiningFailure(cause: unknown, stage: string, requestId: string) {
  const typed = cause instanceof CollaborationApiError;
  const known = typed && Object.hasOwn(refusals, cause.code);
  const status = typed && cause.status >= 400 && cause.status <= 599 ? cause.status : undefined;
  const message = known
    ? refusals[cause.code]
    : status === 401 || status === 403
      ? 'Your sign-in or access changed. Sign in again, then check the retained joining request.'
      : stage === 'capture'
        ? 'The selected agent, account, repository or conversation context could not be checked. Your setup and edits stay here.'
        : 'The joining brief could not be checked. Your setup and edits stay here.';
  return {
    message,
    diagnostic: {
      code: known ? cause.code : `joining_${stage}_failed`,
      stage,
      requestId,
      ...(status === undefined ? {} : { status }),
    },
  };
}
