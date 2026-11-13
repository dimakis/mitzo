import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexCommandInput, CodexConversationStore } from './codex-conversation-store.js';

type AdmissionInput = Parameters<EventStore['admitOrdinaryLocalContinuation']>[2];
/** Original verified owner only. A native queue row supplies correlation, never
 * authorization. The existing operator/runtime owner revalidates before every
 * local receipt mutation, registration and subsequent provider dispatch.
 */
type RecoveryOptions = {
  events: EventStore;
  native: CodexConversationStore;
  sessionId: string;
  account: AccountBinding;
  location: 'local' | 'openshell';
  expected: {
    binding: unknown;
    workspace: { workspaceId: string; cwd: string };
    selection: AdmissionInput['selection'];
  };
  input: CodexCommandInput;
  assertCurrent(): void;
  register(): void;
};
export function admitToolFailureContinuation(options: RecoveryOptions): void {
  const captured = { ...options, input: structuredClone(options.input) };
  if (captured.location !== 'local') return admitToolFailureContinuationNow(captured);
  const sourceId = captured.input.toolFailureContinuation?.sourceCommandId;
  if (!sourceId) throw Error('Original tool recovery source required');
  return captured.events.withOrdinaryDerivedCommandContext(
    captured.sessionId,
    sourceId,
    (assertSourceCurrent) =>
      admitToolFailureContinuationNow({
        ...captured,
        assertCurrent: () => {
          captured.assertCurrent();
          assertSourceCurrent();
        },
      }),
  );
}
function admitToolFailureContinuationNow(options: RecoveryOptions): void {
  const { events, native, sessionId, account, expected, input } = options;
  const check = () => {
    options.assertCurrent();
    native.assertToolFailureContinuation(sessionId, account, input);
    if (!native.assertUndispatchedCommand(sessionId, account, input.id))
      throw Error('Tool recovery already crossed dispatch');
  };
  check();
  const proof = input.toolFailureContinuation!;
  // Peer and Symposium execution have separate consent/turn owners. They retain
  // the actionable failure instead of borrowing ordinary user-command authority.
  if (events.agentCommunication.forCommand(proof.sourceCommandId))
    throw Error('Peer tool recovery requires its original delivery owner');
  const source = events.getOrdinaryCommandExecutionAdmission(proof.sourceCommandId);
  const send = events.getSendCommand(proof.sourceCommandId);
  const meta = events.getSession(sessionId);
  if (
    !source ||
    source.state !== 'consumed' ||
    !send ||
    send.error ||
    send.sessionId !== sessionId ||
    !meta ||
    !isDeepStrictEqual(source.binding, expected.binding) ||
    !isDeepStrictEqual(source.workspace, expected.workspace) ||
    !isDeepStrictEqual(source.selection, expected.selection)
  )
    throw Error('Tool recovery source admission changed');
  const payloadSource = z
    .object({ systemPrompt: z.string(), text: z.string(), intent: z.string().optional() })
    .parse(send.payload);
  const payload = {
    text: input.prompt,
    systemPrompt: payloadSource.systemPrompt,
    intent: payloadSource.intent ?? payloadSource.text,
  };
  if (
    input.intent !== payload.intent ||
    input.model !== expected.selection.model ||
    (input.reasoningEffort ?? null) !== expected.selection.thinking ||
    input.images ||
    input.allowedTools
  )
    throw Error('Tool recovery scope changed');
  const admissionInput: AdmissionInput = {
    clientMsgId: input.id,
    requestFingerprint: `tool-recovery:${createHash('sha256')
      .update(JSON.stringify([source.requestFingerprint, proof, payload]))
      .digest('hex')}`,
    selection: structuredClone(expected.selection),
    payload,
  };
  const selectedMeta = {
    ...meta,
    accountBinding: { ...account, model: expected.selection.model },
    selectedModel: expected.selection.model,
    reasoningEffort: expected.selection.thinking,
  };
  check();
  const primary = source.preparedRepositoryTransition
    ? proof.sourceCommandId
    : source.preparedRepositoryPrimaryCommandId;
  const admitted =
    options.location === 'openshell'
      ? events.admitOrdinaryOpenShellContinuation(selectedMeta, expected.binding, admissionInput)
      : primary
        ? events.admitPreparedRepositoryPrimaryContinuation(
            selectedMeta,
            expected.binding,
            admissionInput,
            primary,
          )
        : events.admitOrdinaryLocalContinuation(selectedMeta, expected.binding, admissionInput);
  check();
  if (admitted.admission.state === 'reserved') {
    const claimed =
      options.location === 'local'
        ? events.claimOrdinaryLocalCommandDispatch(input.id)
        : events.claimOrdinaryOpenShellCommandDispatch(input.id);
    if (!claimed) throw Error('Tool recovery admission claim unavailable');
  }
  // A retained uncertain admission can be completed only under the exact native
  // never-dispatched proof above; no external operation is replayed here.
  check();
  options.register();
  check();
  if (options.location === 'local') events.completeOrdinaryLocalCommand(input.id);
  else events.completeOrdinaryOpenShellCommand(input.id);
  check();
}
