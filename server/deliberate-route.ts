import { createHash } from 'node:crypto';

/** Compatibility digest for explicitly injected reasoning consumers. Production
 * selected harnesses additionally requalify every bound account/target through
 * preparePaidReasoningHarness; no host-default credential file is read here. */
export function deliberateRouteRevision(selection: unknown = null): string {
  return createHash('sha256').update(JSON.stringify(selection)).digest('hex');
}
