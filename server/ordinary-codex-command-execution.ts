import { CollaborationContractError } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

type Store = Pick<
  EventStore,
  'getSendCommand' | 'getOrdinaryCommandExecutionAdmission' | 'readOrdinaryCommandExecutionEvidence'
>;

/** Shared observation for reply provenance and delivery. Historical evidence
 * does not grant dispatch or source access; their live owners retain those fences. */
export function ordinaryCodexCommandExecution(
  store: Store,
  sessionId: string,
  commandId: string,
  options:
    | { historical: true; fingerprint?: string }
    | { historical?: false; requireClaimed?: boolean } = {},
) {
  const command = store.getSendCommand(commandId);
  const admission = options.historical
    ? store.readOrdinaryCommandExecutionEvidence(commandId, options.fingerprint)
    : store.getOrdinaryCommandExecutionAdmission(commandId);
  if (
    !command ||
    command.sessionId !== sessionId ||
    command.error ||
    !admission ||
    admission.binding.version !== 2 ||
    admission.binding.harness.implementation !== 'codex' ||
    ((options.historical || options.requireClaimed) && admission.state === 'reserved')
  )
    throw new CollaborationContractError('reply_conflict');
  return admission;
}
