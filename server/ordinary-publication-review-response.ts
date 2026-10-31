import { z } from 'zod';
import { publicationSearchPrefix } from './ordinary-publication-review-context.js';
import { GithubPublicationReviewError } from './github-publication-review-failure.js';

const ContextRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('read'),
    path: z.string().min(1).max(400),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('search'),
    query: z.string().min(2).max(120),
    pathPrefix: z.string().max(400).optional().transform(publicationSearchPrefix),
  }),
]);
const ReviewResult = z.strictObject({
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedAllEvidence: z.boolean(),
  verdict: z.enum(['approve', 'changes_requested', 'incomplete', 'context_required']),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(['blocking', 'non_blocking']),
        path: z.string().max(200),
        summary: z.string().min(1).max(600),
      }),
    )
    .max(8),
  requests: z.array(ContextRequest).max(8).default([]),
  unresolvedNeeds: z.array(z.string().min(1).max(200)).max(8).default([]),
  coverageSummary: z.string().max(600).optional(),
});
export const reviewResultSchema = JSON.stringify(z.toJSONSchema(ReviewResult, { io: 'input' }));

export type PublicationReviewResponse = z.infer<typeof ReviewResult>;
const fields = new Set([
  'evidenceSha256',
  'reviewedAllEvidence',
  'verdict',
  'findings',
  'severity',
  'path',
  'summary',
  'requests',
  'kind',
  'startLine',
  'endLine',
  'query',
  'pathPrefix',
  'unresolvedNeeds',
  'coverageSummary',
]);
/** Validation diagnostics contain only fixed schema fields/codes, never model
 * text, unknown property names, Zod messages or excerpts from source material. */
export function parsePublicationReviewResponse(text: string): PublicationReviewResponse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GithubPublicationReviewError('PUBLICATION_REVIEW_UNAVAILABLE', {
      reason: 'review_response_invalid_json',
      phase: 'response_validation',
    });
  }
  const parsed = ReviewResult.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((issue) => ({
      field: issue.path.every((part) =>
        typeof part === 'string'
          ? fields.has(part)
          : typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && part < 100000,
      )
        ? issue.path.join('.') || '$'
        : '$',
      code: issue.code,
      ...(issue.code === 'too_big' && typeof issue.maximum === 'number'
        ? { limit: issue.maximum }
        : {}),
    }));
    throw new GithubPublicationReviewError('PUBLICATION_REVIEW_UNAVAILABLE', {
      reason: 'review_response_invalid_schema',
      phase: 'response_validation',
      issues,
    });
  }
  return parsed.data;
}
