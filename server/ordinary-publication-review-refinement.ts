import type { JsonValue } from './connections/types.js';
import { GithubPublicationReviewError } from './github-publication-review-failure.js';

/** One correction of each input error per independent pass. These consume the
 * caller's existing inference/deadline budget; they never accept or repair a
 * rejected response. Only fixed diagnostics and bounded counts enter history. */
export class PublicationReviewRefinements {
  #responseUsed = false;
  #contextUsed = false;
  #needsContext = false;

  response(error: unknown, remainingRounds: number): JsonValue | undefined {
    const details = this.#details(error);
    const reason = details?.reason;
    if (
      remainingRounds < 1 ||
      this.#responseUsed ||
      (reason !== 'review_response_invalid_json' && reason !== 'review_response_invalid_schema')
    )
      return;
    this.#responseUsed = true;
    return {
      reason,
      instruction:
        'The prior response was rejected and is not review evidence. Return a new response matching the full schema and exactly echo the current Evidence SHA-256. No prior verdict or context request was accepted.',
    };
  }

  context(error: unknown, remainingRounds: number): JsonValue | undefined {
    const details = this.#details(error);
    const requestIndex = details?.requestIndex;
    const limit = details?.limit;
    const matchedPathCount = details?.matchedPathCount;
    if (
      remainingRounds < 2 ||
      this.#contextUsed ||
      !details ||
      details.reason !== 'context_search_limit' ||
      typeof requestIndex !== 'number' ||
      !Number.isSafeInteger(requestIndex) ||
      requestIndex < 0 ||
      requestIndex >= 8 ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      typeof matchedPathCount !== 'number' ||
      !Number.isSafeInteger(matchedPathCount) ||
      matchedPathCount <= limit
    )
      return;
    this.#contextUsed = true;
    this.#needsContext = true;
    return {
      reason: 'context_search_limit',
      requestIndex,
      matchedPathCount,
      limit,
      instruction:
        'The whole context batch was rejected before file reads; none of its results count as delivered evidence. Narrow the identified search query or path prefix and resubmit still-needed reads. A successful context batch is required before approval.',
    };
  }

  contextDelivered(): void {
    this.#needsContext = false;
  }

  assertApprovalReady(): void {
    if (this.#needsContext)
      throw new GithubPublicationReviewError('PUBLICATION_REVIEW_BLOCKED', {
        reason: 'context_refinement_required',
      });
  }

  #details(error: unknown): Record<string, JsonValue> | undefined {
    if (
      !(error instanceof GithubPublicationReviewError) ||
      error.code !== 'PUBLICATION_REVIEW_UNAVAILABLE' ||
      !error.details ||
      typeof error.details !== 'object' ||
      Array.isArray(error.details)
    )
      return;
    return error.details;
  }
}
