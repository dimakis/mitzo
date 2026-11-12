import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  OrdinarySdkTurnAcceptedSchema as Accepted,
  OrdinarySdkTurnSettledSchema as Settled,
  OrdinarySdkInterruptTargetSchema,
  type ExecutionToken,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import {
  captureOrdinaryReplyExecution,
  recordOrdinaryReplySource,
} from './collaboration-ordinary-replies.js';
import { ordinaryContributorCommandExecution } from './ordinary-codex-command-execution.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
type Store = Pick<
  EventStore,
  | 'getOrdinarySdkTurnEvents'
  | 'getSendCommand'
  | 'getOrdinaryCommandExecutionAdmission'
  | 'readOrdinaryCommandExecutionEvidence'
  | 'getOrdinaryReplySourceEvents'
  | 'recordOrdinaryProviderTurnTerminal'
  | 'getOrdinaryProviderTurnTerminal'
  | 'append'
>;

function retained(store: Store, sessionId: string, commandId: string) {
  const events = store.getOrdinarySdkTurnEvents(sessionId, commandId);
  const acknowledgments = events.filter((e) => e.type === 'ordinary_sdk_turn_accepted');
  const terminals = events.filter((e) => e.type === 'ordinary_sdk_turn_settled');
  if (events.length > 2 || acknowledgments.length > 1 || terminals.length > 1)
    throw Error('Ambiguous ordinary SDK turn evidence');
  const accepted = acknowledgments[0] ? Accepted.parse(acknowledgments[0].payload) : undefined;
  const settled = terminals[0] ? Settled.parse(terminals[0].payload) : undefined;
  if (accepted?.commandId !== undefined && accepted.commandId !== commandId)
    throw Error('Original ordinary SDK command identity changed');
  if (settled) {
    const identity = Accepted.strip().parse(settled);
    if (!accepted || !isDeepStrictEqual(identity, accepted))
      throw Error('Original ordinary SDK terminal identity changed');
  }
  if (accepted) {
    const admission = ordinaryContributorCommandExecution(store, sessionId, commandId, {
      historical: true,
      fingerprint: accepted.executionFingerprint,
    });
    if (admission.binding.harness.implementation !== 'claude-sdk')
      throw Error('Original ordinary SDK execution required');
  }
  return { accepted, settled };
}

/** Borrowed ordinary command evidence only. The SDK queue and its exact parent
 * input echo own acceptance; callback-settled native results own completion.
 * Renderer text, transport closure and generic execution cleanup prove neither. */
export class OrdinarySdkTurnEvidence {
  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    private readonly sdkSessionId: string,
  ) {
    id.parse(sdkSessionId);
  }

  accepted(commandId: string, inputUuid: string) {
    const execution = captureOrdinaryReplyExecution(this.store, this.sessionId, {
      commandId,
      providerThreadId: this.sdkSessionId,
      providerTurnId: inputUuid,
    });
    const next = Accepted.parse({ version: 1, ...execution });
    const previous = retained(this.store, this.sessionId, commandId);
    if (previous.accepted && !isDeepStrictEqual(previous.accepted, next))
      throw Error('Original ordinary SDK input acknowledgment changed');
    if (!previous.accepted) this.store.append(this.sessionId, 'ordinary_sdk_turn_accepted', next);
    return next;
  }
  interruptTarget(commandId: string, inputUuid: string, execution: ExecutionToken) {
    const { accepted, settled } = retained(this.store, this.sessionId, commandId);
    if (
      !accepted ||
      settled ||
      accepted.providerThreadId !== this.sdkSessionId ||
      accepted.providerTurnId !== inputUuid ||
      execution.sessionId !== this.sessionId
    )
      throw Error('Original SDK interruption target unavailable');
    return OrdinarySdkInterruptTargetSchema.parse({ ...accepted, execution });
  }
  message(commandId: string, messageId: string) {
    const { accepted, settled } = retained(this.store, this.sessionId, commandId);
    if (!accepted || settled || accepted.providerThreadId !== this.sdkSessionId)
      throw Error('Original ordinary SDK reply acknowledgment unavailable');
    const execution = Accepted.omit({ version: true }).strip().parse(accepted);
    recordOrdinaryReplySource(
      this.store,
      this.sessionId,
      {
        commandId,
        messageId,
        providerThreadId: accepted.providerThreadId,
        providerTurnId: accepted.providerTurnId,
      },
      execution,
    );
  }
  settled(commandId: string, inputUuid: string, status: z.infer<typeof Settled>['status']) {
    const previous = retained(this.store, this.sessionId, commandId);
    if (
      !previous.accepted ||
      previous.accepted.providerThreadId !== this.sdkSessionId ||
      previous.accepted.providerTurnId !== inputUuid
    )
      throw Error('Original ordinary SDK result acknowledgment unavailable');
    const next = Settled.parse({ ...previous.accepted, status });
    if (previous.settled && !isDeepStrictEqual(previous.settled, next))
      throw Error('Original ordinary SDK terminal outcome changed');
    this.store.recordOrdinaryProviderTurnTerminal(this.sessionId, commandId, status);
    if (!previous.settled) this.store.append(this.sessionId, 'ordinary_sdk_turn_settled', next);
  }
}

export function observedOrdinarySdkOutcome(store: Store, sessionId: string, commandId: string) {
  const { accepted, settled } = retained(store, sessionId, commandId);
  if (!accepted) return;
  if (!settled || store.getOrdinaryProviderTurnTerminal(sessionId, commandId) !== settled.status)
    return 'uncertain' as const;
  return settled.status;
}
