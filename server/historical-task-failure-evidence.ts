import { createHash } from 'node:crypto';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { reviewedHistoricalTaskFailures } from './historical-task-failure-manifest.js';
export const historicalFailureEvidenceHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const reviewed = new Set(reviewedHistoricalTaskFailures);
/** Only an exact reviewed incident observation qualifies. A diagnostic release,
 * public result envelope, terminal hint or missing run result alone never does. */
export function qualifiesReviewedHistoricalTaskFailure(evidence: unknown): boolean {
  return reviewed.has(historicalFailureEvidenceHash(evidence));
}
