import { createHash } from 'node:crypto';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
const unconfirmed = () => {
  throw new Error('Staging text/tool evidence is unconfirmed');
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read actual durable app facts. Caller-owned result JSON is never input.
 * This proves only a bounded text/Read operation, never runtime cleanup or
 * fresh enrollment; the original owner must bind those separate receipts. */
export function collectStagingTextReadEvidence(
  store: Pick<
    EventStore,
    | 'getSession'
    | 'getExecutionAdmission'
    | 'getExecutionTerminalReason'
    | 'getProviderAttempts'
    | 'getEventsAfter'
  >,
  input: {
    sessionId: string;
    commandId: string;
    binding: AccountBinding;
    selectedModel: string;
    fixturePath: string;
    nonce: string;
    afterSeq: number;
  },
) {
  if (
    !Number.isSafeInteger(input.afterSeq) ||
    input.afterSeq < 0 ||
    !input.nonce ||
    input.nonce.length > 256 ||
    !input.fixturePath
  )
    unconfirmed();
  const session = store.getSession(input.sessionId);
  const admission = store.getExecutionAdmission(input.sessionId, input.commandId);
  if (
    !session ||
    !admission ||
    session.executionId !== admission.token.executionId ||
    session.executionGeneration !== admission.token.generation ||
    session.executionPhase !== 'TERMINAL' ||
    store.getExecutionTerminalReason(admission.token) !== 'completed' ||
    session.selectedModel !== input.selectedModel ||
    !session.accountBinding ||
    ['accountId', 'provider', 'profileRevision'].some(
      (key) =>
        session.accountBinding![key as keyof AccountBinding] !==
        input.binding[key as keyof AccountBinding],
    )
  )
    unconfirmed();
  const attempts = store.getProviderAttempts(admission!.token);
  if (
    attempts.length !== 1 ||
    attempts[0].phase !== 'TERMINAL' ||
    attempts[0].terminalReason !== 'completed'
  )
    unconfirmed();
  const events = store.getEventsAfter(input.sessionId, input.afterSeq, 257);
  const outputBytes = Buffer.byteLength(JSON.stringify(events));
  if (
    !events.length ||
    events.length > 256 ||
    outputBytes > 65536 ||
    events.some((event) => event.sessionId !== input.sessionId)
  )
    unconfirmed();
  // Exclude stale events from an earlier generation even in the same session.
  const starts = events.filter(
    (event) => event.type === 'execution_state_changed' && event.payload.phase === 'RUNNING',
  );
  if (
    starts.length !== 1 ||
    starts[0].payload.executionId !== admission!.token.executionId ||
    starts[0].payload.generation !== admission!.token.generation
  )
    unconfirmed();
  const toolEnds = events.filter(
    (event) => event.type === 'block_end' && event.payload.blockType === 'tool_use',
  );
  if (toolEnds.length !== 1 || toolEnds[0].payload.toolName !== 'Read') unconfirmed();
  const read = toolEnds[0].payload;
  const raw = read.rawInput as { type?: unknown; path?: unknown } | undefined;
  if (raw?.type !== 'read' || raw.path !== input.fixturePath || typeof read.toolId !== 'string')
    unconfirmed();
  const results = events.filter(
    (event) => event.type === 'tool_result' && event.payload.toolId === read.toolId,
  );
  if (
    results.length !== 1 ||
    results[0].payload.isError !== false ||
    typeof results[0].payload.result !== 'string' ||
    !results[0].payload.result.includes(input.nonce)
  )
    unconfirmed();
  const textBlocks = new Set(
    events
      .filter((event) => event.type === 'block_start' && event.payload.blockType === 'text')
      .map((event) => event.payload.blockId),
  );
  const textEvents = events.filter(
    (event) =>
      event.type === 'block_delta' &&
      textBlocks.has(event.payload.blockId) &&
      typeof event.payload.delta === 'string',
  );
  if (
    !textEvents.length ||
    !textEvents
      .map((event) => event.payload.delta)
      .join('')
      .includes(input.nonce)
  )
    unconfirmed();
  return {
    sessionId: input.sessionId,
    executionId: admission!.token.executionId,
    generation: admission!.token.generation,
    providerAttemptId: attempts[0].token.providerAttemptId,
    providerDispatches: 1,
    outputBytes,
    durableEvidenceSha256: digest(events),
    observations: [
      { feature: 'stream-text', outcome: 'passed' as const, evidenceSha256: digest(textEvents) },
      {
        feature: 'context-read',
        outcome: 'passed' as const,
        evidenceSha256: digest([toolEnds[0], results[0]]),
      },
    ],
  };
}
