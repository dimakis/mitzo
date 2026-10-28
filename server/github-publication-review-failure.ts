import type { JsonValue } from './connections/types.js';

const undispatched = new WeakSet<Error>();
/** The publication executor alone marks this while no host push has been
 * invoked. The identity is process-local, one-use and never durable input. */
export function markGithubPublicationNotDispatched(error: unknown): Error {
  const failure =
    error instanceof Error ? error : new Error('GitHub publication was not dispatched');
  undispatched.add(failure);
  return failure;
}
export function consumeGithubPublicationNotDispatched(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return undispatched.delete(error);
}

const messages = {
  PUBLICATION_REVIEW_REQUIRED:
    'Independent publication review is required. Request publication again to review the current committed change.',
  PUBLICATION_REVIEW_BLOCKED:
    'Independent review found issues that must be addressed before publication. Fix the reported findings, commit the changes and request publication again.',
  PUBLICATION_REVIEW_UNAVAILABLE:
    'Independent review could not complete. Local commits are preserved. Request publication again for a fresh review after resolving the reported requirement.',
  PUBLICATION_REVIEW_CHANGED:
    'The committed change or reviewer authority changed after review. Local commits are preserved. Request publication again to review the current change.',
} as const;
export type GithubPublicationReviewFailureCode = keyof typeof messages;
/** Only the host review owner constructs public diagnostics. Raw provider,
 * command and credential errors must never be passed as details. */
export class GithubPublicationReviewError extends Error {
  readonly details?: JsonValue;
  constructor(
    readonly code: GithubPublicationReviewFailureCode,
    details?: JsonValue,
  ) {
    super(messages[code]);
    if (details !== undefined) {
      const encoded = JSON.stringify(details);
      if (encoded && Buffer.byteLength(encoded, 'utf8') <= 8192)
        this.details = JSON.parse(encoded) as JsonValue;
    }
  }
}
export function safeGithubPublicationReviewFailure(error: unknown) {
  return error instanceof GithubPublicationReviewError
    ? {
        code: error.code,
        message: messages[error.code],
        ...(error.details !== undefined ? { details: error.details } : {}),
      }
    : undefined;
}
export function githubPublicationReviewFailureMessage(code: string | null | undefined) {
  return code && Object.hasOwn(messages, code)
    ? messages[code as GithubPublicationReviewFailureCode]
    : undefined;
}
