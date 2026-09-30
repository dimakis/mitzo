import { z } from 'zod';
import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';

export const MAX_STRUCTURED_REVIEW_BYTES = 64 * 1024;
const text = z.string().min(1).max(2048);
const ref = z.string().min(1).max(256);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
/** Model fields contain findings only; identities and authority never come from output. */
export const StructuredReviewOutputSchema = z.strictObject({
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(['critical', 'high', 'medium', 'low']),
        criterion: ref,
        summary: text,
        location: text,
        evidenceRefs: z.array(ref).min(1).max(16),
      }),
    )
    .max(64),
  resolvedFingerprints: z.array(fingerprint).max(64),
});
export const ReviewOutputScopeSchema = z.strictObject({
  criteria: z.array(ref).min(1).max(128),
  evidenceRefs: z.array(ref).max(256),
  openFingerprints: z.array(fingerprint).max(128),
});
export type ReviewOutputScope = z.infer<typeof ReviewOutputScopeSchema>;
export type UntrustedReviewOutput = z.infer<typeof StructuredReviewOutputSchema>;
/** Suitable for a future native outputSchema argument; currently not wired to dispatch. */
export const structuredReviewOutputSchema = z.toJSONSchema(StructuredReviewOutputSchema);

export function parseUntrustedReviewOutput(raw: string, scopeInput: ReviewOutputScope) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_STRUCTURED_REVIEW_BYTES)
    throw new Error('Structured review exceeds byte limit');
  const scope = ReviewOutputScopeSchema.parse(scopeInput);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('Malformed structured review');
  }
  const output = StructuredReviewOutputSchema.parse(decoded);
  const criteria = new Set(scope.criteria);
  const refs = new Set(scope.evidenceRefs);
  const fingerprints = new Set(scope.openFingerprints);
  if (
    output.findings.some(
      (finding) =>
        !criteria.has(finding.criterion) ||
        finding.evidenceRefs.some((value) => !refs.has(value)) ||
        new Set(finding.evidenceRefs).size !== finding.evidenceRefs.length,
    ) ||
    output.resolvedFingerprints.some((value) => !fingerprints.has(value)) ||
    new Set(output.resolvedFingerprints).size !== output.resolvedFingerprints.length
  )
    throw new Error('Structured review references unknown or duplicate scope');
  const canonical = canonicalReviewJson(output);
  return { trust: 'untrusted' as const, output, canonical, hash: reviewRecordHash(canonical) };
}
