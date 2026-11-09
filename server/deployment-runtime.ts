import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { assertOrdinaryContributorControlAllowed } from './ordinary-contributor-execution.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationSettingsSchema,
  AccountBindingSchema,
  SessionRuntimeBindingSchema,
} from '@mitzo/protocol';
import { getCodexRuntime, getCodexConversationStore } from './codex-chat-session.js';
import { CodexNativeTurnTargetSchema } from './codex-conversation-store.js';
import { createSessionPromptPort } from './session-prompt-dispatch.js';
import {
  hasPersistentRevocationAuthority,
  isAuthSessionCurrent,
  type AuthSession,
} from './auth.js';
import { DeploymentCoordinator } from './deployment-coordinator.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

const Snapshot = z.strictObject({
  target: CodexNativeTurnTargetSchema,
  account: AccountBindingSchema,
  binding: SessionRuntimeBindingSchema,
  settings: CollaborationSettingsSchema,
  cwd: z.string().min(1),
});

/** Supports owned ordinary Codex only. Other live owners and startup uncertainty
 * fail preflight; no legacy, Symposium or credential-control fallback is borrowed. */
export function createDeploymentRuntime(
  ctx: Pick<V2HandlerContext, 'eventStore' | 'sessionRegistry' | 'connRegistry'>,
  deps: {
    commit(): string;
    healthy(): boolean;
    backgroundIdle(): boolean;
    authorizeSession(id: string, auth: AuthSession): void;
  },
) {
  const events = ctx.eventStore,
    registry = ctx.sessionRegistry;
  const prompts = createSessionPromptPort(ctx);
  type Entry = ReturnType<typeof events.deployment.get>['sessions'][number];
  function authorize(auth: AuthSession) {
    if (!hasPersistentRevocationAuthority() || !isAuthSessionCurrent(auth))
      throw Error('Current signed deployment operator required');
  }
  function snapshot(id: string, auth: AuthSession) {
    authorize(auth);
    deps.authorizeSession(id, auth);
    events.removals.assertAdmissible(id);
    assertOrdinaryContributorControlAllowed(events, id, 'interrupt');
    const meta = events.getSession(id),
      binding = events.getSessionRuntimeBinding(id);
    const admission = events.getLatestOrdinaryCommandAdmission(id);
    if (
      !isAvailableTelosWorkConversation(meta) ||
      events.getLatestEvent(id, 'adviser_task_scope') ||
      !meta?.accountBinding ||
      !meta.cwd ||
      meta.symposiumConfig ||
      binding?.harness.implementation !== 'codex' ||
      binding.version !== 2 ||
      !admission ||
      admission.state !== 'consumed' ||
      !isDeepStrictEqual(binding, admission.binding)
    )
      throw Error('Owned ordinary Codex conversation required');
    return {
      account: meta.accountBinding,
      binding,
      cwd: meta.cwd,
      settings: {
        binding: admission.binding,
        selection: admission.selection,
        repositoryWorkspaceId: admission.workspace.workspaceId,
      },
    };
  }
  function validate(entry: Entry, auth: AuthSession) {
    const expected = Snapshot.parse(entry.snapshot);
    if (
      !isDeepStrictEqual(snapshot(entry.sessionId, auth), {
        account: expected.account,
        binding: expected.binding,
        cwd: expected.cwd,
        settings: expected.settings,
      })
    )
      throw Error('Captured deployment session settings changed');
    return expected;
  }
  function receipt(entry: Entry) {
    const command = events.getSendCommand(entry.resumeId);
    if (!command) return 'absent' as const;
    if (command.sessionId !== entry.sessionId) return 'uncertain' as const;
    return events.readOrdinaryCommandExecutionEvidence(entry.resumeId)?.state === 'consumed'
      ? ('accepted' as const)
      : ('uncertain' as const);
  }
  const coordinator = new DeploymentCoordinator(events.deployment, {
    commit: deps.commit,
    healthy: deps.healthy,
    authorize,
    capture(auth) {
      if (!deps.backgroundIdle())
        throw Error('Background controller is active; deployment is blocked');
      const captured: Array<{ sessionId: string; snapshot: Record<string, unknown> }> = [];
      for (const active of registry.getActiveSessions()) {
        if (!active.sessionId) throw Error('Unresolved session startup blocks deployment');
        const id = active.sessionId;
        const retained = snapshot(id, auth);
        const runtime = getCodexRuntime(registry.findBySessionId(id)!.session);
        if (!runtime) throw Error('Unqualified live runtime blocks deployment');
        if (runtime.deploymentChildActivity())
          throw Error('Pending child discovery blocks deployment');
        const target = runtime.captureInterruptTarget();
        if (target)
          captured.push({
            sessionId: id,
            snapshot: { ...retained, target: CodexNativeTurnTargetSchema.parse(target) },
          });
        else if (
          active.hasSnapshot ||
          active.turnInProgress ||
          getCodexConversationStore().hasRunningCommands(id)
        )
          throw Error('Unconfirmed native startup blocks deployment; retry after it settles');
      }
      // Unregistered/cold running native commands are uncertainty, not idle.
      const ids = new Set(captured.map((entry) => entry.sessionId));
      if (
        getCodexConversationStore()
          .subagents.unsettledConversationIds()
          .some((id) => !ids.has(id))
      )
        throw Error('Uncaptured child activity blocks deployment');
      if (
        getCodexConversationStore()
          .runningConversationIds()
          .some((id) => !ids.has(id)) ||
        events
          .listSessions()
          .some(
            (session) =>
              session.executionPhase &&
              session.executionPhase !== 'TERMINAL' &&
              !ids.has(session.sessionId),
          )
      )
        throw Error('Unowned or unresolved execution blocks deployment');
      return captured;
    },
    validate,
    async pause(entry, auth) {
      const expected = validate(entry, auth);
      const runtime = registry.findBySessionId(entry.sessionId)?.session;
      const owner = runtime && getCodexRuntime(runtime);
      if (!owner) throw Error('Original live runtime unavailable');
      const target = owner.captureInterruptTarget();
      if (
        !target ||
        !isDeepStrictEqual(CodexNativeTurnTargetSchema.parse(target), expected.target)
      ) {
        if (owner.deploymentTurnSettled(expected.target)) return;
        throw Error('Original native turn changed');
      }
      validate(entry, auth);
      await owner.pauseForDeployment(entry.interruptId, target, () => {
        validate(entry, auth);
      });
    },
    async settled(entry, auth) {
      const expected = validate(entry, auth);
      const session = registry.findBySessionId(entry.sessionId)?.session;
      const owner = session && getCodexRuntime(session);
      return entry.pauseSettled
        ? getCodexConversationStore().deploymentTurnSettled(
            entry.sessionId,
            expected.account,
            expected.target,
          )
        : !!owner &&
            owner.observeDeploymentSettlement(expected.target, () => {
              validate(entry, auth);
            });
    },
    quiescent: () =>
      deps.backgroundIdle() &&
      !getCodexConversationStore().hasRunningCommands() &&
      getCodexConversationStore().subagents.unsettledConversationIds().length === 0 &&
      registry.getActiveSessions().every(({ sessionId }) => {
        const session = sessionId && registry.findBySessionId(sessionId)?.session;
        return !session || !getCodexRuntime(session)?.deploymentChildActivity();
      }) &&
      !events
        .listSessions()
        .some((session) => session.executionPhase && session.executionPhase !== 'TERMINAL') &&
      registry
        .getActiveSessions()
        .every((session) => !session.hasSnapshot && !session.turnInProgress),
    receipt,
    resume(entry, auth, signal, assertCurrent) {
      const expected = validate(entry, auth);
      return prompts.deliverOrdinary(
        {
          sessionId: entry.sessionId,
          commandId: entry.resumeId,
          auth,
          settings: expected.settings,
          text: 'The server deployment pause has ended. Continue the existing task under its existing instructions and approvals. Do not replay completed or uncertain tools. Inspect retained state and preserve queued input ordering.',
        },
        signal,
        assertCurrent,
      );
    },
  });
  return { coordinator, close: () => prompts.close() };
}
