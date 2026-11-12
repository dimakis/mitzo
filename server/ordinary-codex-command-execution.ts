import { CollaborationContractError } from '@mitzo/protocol';
import { OrdinaryExecutionEvidenceUnavailable, type EventStore } from './event-store.js';

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
  const admission = ordinaryContributorCommandExecution(store, sessionId, commandId, options);
  if (admission.binding.harness.implementation !== 'codex')
    throw new CollaborationContractError('reply_conflict');
  return admission;
}

/** Exact owned native Codex or local Claude SDK provenance. This is historical
 * evidence only; ordinary admission and current execution authority stay with
 * their original owners. Retired Responses and arbitrary harnesses stay refused. */
export function ordinaryContributorCommandExecution(
  store: Store,
  sessionId: string,
  commandId: string,
  options:
    | { historical: true; fingerprint?: string }
    | { historical?: false; requireClaimed?: boolean } = {},
) {
  const command = store.getSendCommand(commandId);
  let admission;
  try {
    admission = options.historical
      ? store.readOrdinaryCommandExecutionEvidence(commandId, options.fingerprint)
      : store.getOrdinaryCommandExecutionAdmission(commandId);
  } catch (error) {
    if (options.historical && error instanceof OrdinaryExecutionEvidenceUnavailable)
      throw new CollaborationContractError('reply_conflict');
    throw error;
  }
  if (
    !command ||
    command.sessionId !== sessionId ||
    command.error ||
    !admission ||
    admission.binding.version !== 2 ||
    !(
      admission.binding.harness.implementation === 'codex' ||
      (admission.binding.harness.implementation === 'claude-sdk' &&
        admission.binding.execution.location === 'local' &&
        ['anthropic-claude', 'anthropic-vertex', 'anthropic-api'].includes(
          admission.binding.account.provider,
        ))
    ) ||
    ((options.historical || options.requireClaimed) && admission.state === 'reserved')
  )
    throw new CollaborationContractError('reply_conflict');
  return admission;
}
