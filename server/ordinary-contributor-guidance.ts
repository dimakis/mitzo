import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';

interface GuidanceReader {
  getSessionEvents(sessionId: string): Array<{ type: string; payload: Record<string, unknown> }>;
}
interface GuidanceWriter extends GuidanceReader {
  append(sessionId: string, type: string, payload: Record<string, unknown>): number;
}
const Snapshot = z.strictObject({
  version: z.literal(1),
  sessionId: z.string().min(1),
  binding: z.strictObject({
    accountId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    profileRevision: z.string().min(1),
  }),
  guidance: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 100_000),
  guidanceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
function scope(binding: AccountBinding) {
  return {
    accountId: binding.accountId,
    provider: binding.provider,
    model: binding.model,
    profileRevision: binding.profileRevision,
  };
}
function hash(guidance: string) {
  return createHash('sha256').update(guidance, 'utf8').digest('hex');
}

/** Restore only host-written, account-bound guidance for this exact child conversation. */
export function resolveOrdinaryContributorGuidance(
  store: GuidanceReader,
  sessionId: string | undefined,
  binding: AccountBinding | undefined,
  requested?: string,
): string | undefined {
  if (requested !== undefined && Buffer.byteLength(requested, 'utf8') > 100_000)
    throw new Error('Contributor guidance exceeds the supported size');
  const records = sessionId
    ? store.getSessionEvents(sessionId).filter((event) => event.type === 'contributor_guidance')
    : [];
  if (!records.length) return requested;
  if (!binding)
    throw new Error('Retained contributor guidance requires its original account binding');
  const saved = records.map((event) => Snapshot.parse(event.payload));
  const first = saved[0];
  if (
    first.sessionId !== sessionId ||
    JSON.stringify(first.binding) !== JSON.stringify(scope(binding)) ||
    first.guidanceHash !== hash(first.guidance) ||
    saved.some((snapshot) => JSON.stringify(snapshot) !== JSON.stringify(first)) ||
    (requested !== undefined && requested !== first.guidance)
  )
    throw new Error('Retained contributor guidance or account scope changed');
  return first.guidance;
}

/** This internal entry point is never mapped from an HTTP/WS request field. */
export function saveOrdinaryContributorGuidance(
  store: GuidanceWriter,
  sessionId: string,
  binding: AccountBinding | undefined,
  guidance: string,
): void {
  if (!binding) throw new Error('Contributor guidance requires an explicit account binding');
  resolveOrdinaryContributorGuidance(store, sessionId, binding, guidance);
  if (store.getSessionEvents(sessionId).some((event) => event.type === 'contributor_guidance'))
    return;
  store.append(
    sessionId,
    'contributor_guidance',
    Snapshot.parse({
      version: 1,
      sessionId,
      binding: scope(binding),
      guidance,
      guidanceHash: hash(guidance),
    }),
  );
}
