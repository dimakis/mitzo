import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unconfirmed = (): never => {
  throw Error('Original native text/Read evidence unconfirmed');
};
/** Read original app dispatch, native acceptance/terminal observations, and
 * attributed durable tool/text events. Model HTTP enforcement and physical
 * retirement remain separate original-owner receipts, never inferred here. */
export function collectStagingNativeTextReadEvidence(
  store: EventStore,
  registry: SymposiumAttemptRegistry,
  input: {
    sessionId: string;
    deliveryId: string;
    binding: AccountBinding;
    fixturePath: string;
    nonce: string;
    afterSeq: number;
  },
) {
  if (
    !Number.isSafeInteger(input.afterSeq) ||
    input.afterSeq < 0 ||
    !/^[a-f0-9]{64}$/.test(input.nonce)
  )
    unconfirmed();
  const delivery = store.getSymposiumDelivery(input.deliveryId);
  const attempts = store.getSymposiumRecipientAttempts(input.deliveryId, 'primary');
  if (
    delivery?.sessionId !== input.sessionId ||
    delivery.status !== 'delivered' ||
    delivery.recipientSeatIds.length !== 1 ||
    delivery.recipientSeatIds[0] !== 'primary' ||
    attempts.length !== 1
  )
    unconfirmed();
  const attempt = attempts[0];
  if (!attempt.claimToken) return unconfirmed();
  const observation = registry.observations.get(attempt.claimToken);
  const claim = registry.get(attempt.claimToken);
  if (
    attempt.status !== 'delivered' ||
    attempt.acceptedAt === null ||
    !attempt.provenance ||
    !observation ||
    observation.status !== 'completed' ||
    observation.terminalAt === null ||
    observation.terminalConflict ||
    claim?.sessionId !== input.sessionId ||
    observation.identity.claimToken !== attempt.claimToken ||
    observation.identity.sessionId !== input.sessionId ||
    observation.identity.seatId !== 'primary' ||
    observation.identity.providerThreadId !== attempt.providerThreadId ||
    observation.identity.providerTurnId !== attempt.providerTurnId ||
    !isDeepStrictEqual(observation.identity.accountBinding, input.binding) ||
    !isDeepStrictEqual(observation.identity.provenance, attempt.provenance)
  )
    return unconfirmed();
  const all = store.getEventsAfter(input.sessionId, input.afterSeq, 257);
  const outputBytes = Buffer.byteLength(JSON.stringify(all));
  if (
    all.length > 256 ||
    outputBytes > 65536 ||
    all.some(
      (event) =>
        event.sessionId !== input.sessionId ||
        (event.payload.nativeClaimToken && event.payload.nativeClaimToken !== attempt.claimToken),
    )
  )
    unconfirmed();
  const events = all.filter((event) => event.payload.nativeClaimToken === attempt.claimToken);
  if (
    !events.length ||
    events.some(
      (event) =>
        event.seatId !== 'primary' ||
        !isDeepStrictEqual(event.symposiumProvenance, attempt.provenance),
    )
  )
    unconfirmed();
  const reads = events.filter(
    (event) => event.type === 'block_end' && event.payload.blockType === 'tool_use',
  );
  if (
    reads.length !== 1 ||
    reads[0].payload.toolName !== 'Read' ||
    typeof reads[0].payload.toolId !== 'string'
  )
    unconfirmed();
  const raw = reads[0].payload.rawInput as { file_path?: unknown; path?: unknown } | undefined;
  // Claude's Read and the native Codex bridge use their own concrete argument
  // shape; the ordinary query-loop's normalized type/read object is not proof.
  if (!raw || (raw.file_path ?? raw.path) !== input.fixturePath) unconfirmed();
  const results = events.filter(
    (event) => event.type === 'tool_result' && event.payload.toolId === reads[0].payload.toolId,
  );
  if (
    results.length !== 1 ||
    results[0].payload.isError !== false ||
    typeof results[0].payload.result !== 'string' ||
    !results[0].payload.result.includes(input.nonce)
  )
    unconfirmed();
  const blocks = new Set(
    events
      .filter((event) => event.type === 'block_start' && event.payload.blockType === 'text')
      .map((event) => event.payload.blockId),
  );
  const text = events.filter(
    (event) =>
      event.type === 'block_delta' &&
      blocks.has(event.payload.blockId) &&
      typeof event.payload.delta === 'string',
  );
  if (
    !text
      .map((event) => event.payload.delta)
      .join('')
      .includes(input.nonce)
  )
    unconfirmed();
  return Object.freeze({
    version: 1,
    sessionId: input.sessionId,
    deliveryId: input.deliveryId,
    claimToken: attempt.claimToken,
    seatId: observation.identity.seatId,
    generation: observation.identity.membershipGeneration,
    providerThreadId: observation.identity.providerThreadId,
    providerTurnId: observation.identity.providerTurnId,
    outputBytes,
    durableEvidenceSha256: digest(events),
    nativeObservationSha256: digest(observation),
    observations: [
      { feature: 'stream-text', outcome: 'passed' as const, evidenceSha256: digest(text) },
      {
        feature: 'context-read',
        outcome: 'passed' as const,
        evidenceSha256: digest([reads[0], results[0]]),
      },
    ],
  });
}
