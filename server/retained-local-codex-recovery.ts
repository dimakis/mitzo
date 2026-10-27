import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import { assembleSourceSnapshots } from './source-snapshot-context.js';
import {
  ordinaryLocalCommandFingerprint,
  OrdinaryLocalCodexCommandRequestSchema,
  type OrdinaryLocalCodexAdmissionExpectation,
} from './ordinary-local-codex-admission.js';

const unavailable = () => Error('Retained local command recovery unavailable');

export function recoverableLocalCodexCommand(
  events: EventStore,
  native: CodexConversationStore,
  sessionId: string,
  authSessionId: string,
): string | undefined {
  const meta = events.getSession(sessionId);
  if (!meta?.accountBinding) return undefined;
  try {
    for (const commandId of native.undispatchedRecoveryCandidateIds(
      sessionId,
      meta.accountBinding,
    )) {
      try {
        RetainedLocalCodexRecovery.captureSaved(
          events,
          native,
          sessionId,
          authSessionId,
          commandId,
        );
        return commandId;
      } catch {
        /* A receipt is not a grant to replay an unknown provider effect. */
      }
    }
  } catch {
    /* Missing private custody stays unavailable. */
  }
  return undefined;
}

/** An explicit retry may reopen native custody only when the original command
 * never crossed the provider boundary. This is not permission to replay a turn.
 * Its receipt, fingerprint, settings, workspace and command ID remain unchanged.
 */
export class RetainedLocalCodexRecovery {
  private claimed = false;
  private completed = false;
  private constructor(
    private readonly events: EventStore,
    private readonly native: CodexConversationStore,
    readonly sessionId: string,
    readonly commandId: string,
    private readonly authSessionId: string,
    private readonly receipt: NonNullable<
      ReturnType<EventStore['getOrdinaryLocalCommandAdmission']>
    >,
    private readonly payload: unknown,
    private readonly account: AccountBinding,
  ) {}

  static capture(
    events: EventStore,
    native: CodexConversationStore,
    sessionId: string,
    authSessionId: string,
    raw: unknown,
  ) {
    return this.captureRequest(events, native, sessionId, authSessionId, raw, true);
  }

  /** Existing queue action selects saved server input, never a reconstructed
   * client draft or a new capability grant. Original receipt lineage is retained. */
  static captureSaved(
    events: EventStore,
    native: CodexConversationStore,
    sessionId: string,
    authSessionId: string,
    commandId: string,
  ) {
    const receipt = events.getOrdinaryLocalCommandExecutionAdmission(commandId);
    const send = events.getSendCommand(commandId);
    if (!receipt || !send || send.sessionId !== sessionId) throw unavailable();
    const payload = { ...send.payload } as Record<string, unknown>;
    delete payload.systemPrompt;
    const request = {
      clientMsgId: commandId,
      capabilityRevision: 'retained-local-command',
      runtime: {
        account: receipt.binding.account,
        harness: 'codex' as const,
        targetId: receipt.binding.execution.targetId,
        mode: receipt.selection.permission.mode,
      },
      selection: receipt.selection,
      payload,
    };
    return {
      request,
      proof: this.captureRequest(events, native, sessionId, authSessionId, request, false),
    };
  }

  private static captureRequest(
    events: EventStore,
    native: CodexConversationStore,
    sessionId: string,
    authSessionId: string,
    raw: unknown,
    verifyFingerprint: boolean,
  ) {
    const request = OrdinaryLocalCodexCommandRequestSchema.parse(raw);
    const meta = events.getSession(sessionId);
    const receipt = events.getOrdinaryLocalCommandExecutionAdmission(request.clientMsgId);
    const send = events.getSendCommand(request.clientMsgId);
    if (
      !meta?.accountBinding ||
      meta.isHidden ||
      events.hasUncertainOrdinaryCommand(sessionId, request.clientMsgId) ||
      !receipt ||
      !send ||
      send.error ||
      send.sessionId !== sessionId ||
      !['uncertain', 'consumed'].includes(receipt.state) ||
      receipt.preparedRepositoryTransition ||
      !isDeepStrictEqual(receipt.binding, events.getSessionRuntimeBinding(sessionId)) ||
      receipt.binding.harness.implementation !== 'codex' ||
      receipt.binding.execution.location !== 'local' ||
      !isDeepStrictEqual(receipt.selection, request.selection) ||
      !isDeepStrictEqual(receipt.binding.account, request.runtime.account) ||
      receipt.binding.execution.targetId !== request.runtime.targetId ||
      request.runtime.harness !== 'codex' ||
      receipt.workspace.cwd !== meta.cwd ||
      receipt.workspace.workspaceId !== (meta.ordinaryWorkspaceId ?? meta.repositoryWorkspaceId) ||
      meta.mode !== request.selection.permission.mode
    )
      throw unavailable();
    const payload = { ...send.payload } as Record<string, unknown>;
    delete payload.systemPrompt;
    const original = receipt.preparedRepositoryPrimaryCommandId
      ? events.getPreparedRepositoryCommandAdmissionEvidence(
          request.clientMsgId,
          receipt.preparedRepositoryPrimaryCommandId,
        )
      : receipt;
    if (
      !isDeepStrictEqual(payload, request.payload) ||
      (verifyFingerprint &&
        original.requestFingerprint !==
          ordinaryLocalCommandFingerprint(
            'codex',
            { ...request, payload: send.payload },
            {
              workspace: original.workspace,
              agentProfile: meta.agentProfile,
              agentContext: meta.agentContext,
            },
          ))
    )
      throw unavailable();
    const proof = new RetainedLocalCodexRecovery(
      events,
      native,
      sessionId,
      request.clientMsgId,
      authSessionId,
      structuredClone(receipt),
      structuredClone(send.payload),
      structuredClone(meta.accountBinding),
    );
    proof.assertCurrentSync();
    return proof;
  }

  assertCurrentSync(): void {
    const current = this.events.getOrdinaryLocalCommandExecutionAdmission(this.commandId);
    const send = this.events.getSendCommand(this.commandId);
    const meta = this.events.getSession(this.sessionId);
    if (
      !current ||
      !isDeepStrictEqual({ ...current, state: this.receipt.state }, this.receipt) ||
      !['uncertain', 'consumed'].includes(current.state) ||
      send?.error ||
      send?.sessionId !== this.sessionId ||
      !isDeepStrictEqual(send.payload, this.payload) ||
      !isDeepStrictEqual(meta?.accountBinding, this.account) ||
      !isDeepStrictEqual(
        this.events.getSessionRuntimeBinding(this.sessionId),
        this.receipt.binding,
      ) ||
      meta?.cwd !== this.receipt.workspace.cwd ||
      (meta?.ordinaryWorkspaceId ?? meta?.repositoryWorkspaceId) !==
        this.receipt.workspace.workspaceId ||
      !ordinaryOperatorOwnsConversation(
        this.native.readHostCustody(this.sessionId, this.account!)?.authSessionId,
        this.authSessionId,
      ) ||
      this.native.read(this.sessionId, this.account!).cwd !== this.receipt.workspace.cwd
    )
      throw unavailable();
    const queued = this.native.assertUndispatchedCommand(
      this.sessionId,
      this.account!,
      this.commandId,
    );
    if (this.receipt.state === 'consumed' && !queued) throw unavailable();
    if (queued) {
      const p = this.payload as {
        text: string;
        intent?: string;
        sourceSnapshots?: Parameters<typeof assembleSourceSnapshots>[1];
        images?: unknown;
      };
      if (
        queued.prompt !== assembleSourceSnapshots(p.text, p.sourceSnapshots) ||
        (queued.intent ?? queued.prompt) !== (p.intent ?? p.text) ||
        !isDeepStrictEqual(queued.images ?? [], p.images ?? []) ||
        queued.model !== this.receipt.selection.model ||
        (queued.reasoningEffort ?? null) !== this.receipt.selection.thinking
      )
        throw unavailable();
    }
  }

  get requestFingerprint() {
    return this.receipt.requestFingerprint;
  }
  /** A rebound input already has a consumed original receipt. Its current
   * execution admission proves completion; re-running generic completion would
   * compare that historical workspace against the adopted session workspace. */
  complete(): void {
    if (!this.claimed || this.completed) throw unavailable();
    this.assertCurrentSync();
    const current = this.events.getOrdinaryLocalCommandExecutionAdmission(this.commandId);
    if (current?.state === 'uncertain') this.events.completeOrdinaryLocalCommand(this.commandId);
    this.assertCurrentSync();
    this.completed = true;
  }
  prepareQueue(): void {
    this.assertCurrentSync();
    this.native.requeueUndispatchedCommand(this.sessionId, this.account, this.commandId, () => {
      this.assertCurrentSync();
      this.events.append(this.sessionId, 'command_preparation_recovered', {
        commandId: this.commandId,
        attempt: 1,
        previousStatus: 'failed',
        reason: 'no_native_dispatch',
      });
    });
  }
  claim(expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>, payload: unknown): boolean {
    this.assertCurrentSync();
    if (
      this.claimed ||
      !isDeepStrictEqual(expected.binding, this.receipt.binding) ||
      !isDeepStrictEqual(expected.workspace, this.receipt.workspace) ||
      !isDeepStrictEqual(expected.selection, this.receipt.selection) ||
      !isDeepStrictEqual(payload, this.payload)
    )
      throw unavailable();
    this.claimed = true;
    return true;
  }
}
