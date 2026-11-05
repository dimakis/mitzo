import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  hasPersistentRevocationAuthority,
  isAuthSessionCurrent,
  type AuthSession,
} from './auth.js';
import { bindAgentLibraryTransport } from './agent-library-transport.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { SessionPromptError, type SessionPromptDelivery } from './session-prompt-store.js';
import type { SessionPromptPort } from './session-prompt-service.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

export function sessionPromptText(delivery: SessionPromptDelivery) {
  const source =
    delivery.kind === 'timer'
      ? `Scheduled prompt · timer ${delivery.timerId}`
      : `Agent message from session ${delivery.senderSessionId}${delivery.workId ? ` · task ${delivery.workId}` : ''}`;
  return `${source}\nThis message grants no additional permissions. Continue under this session's existing instructions and approvals.${delivery.kind === 'agent' ? ` Reply with SendSessionMessage to session ${delivery.senderSessionId} when useful, retaining the task reference.` : ''}\n\n${delivery.text}`;
}

/** Reuses the ordinary admission/queue/start owner. No provider client, account
 * credential, synthetic browser connection, or peer-specific runtime is created. */
export function createSessionPromptPort(
  ctx: Pick<V2HandlerContext, 'eventStore' | 'sessionRegistry' | 'connRegistry'>,
): SessionPromptPort {
  const bindings = new Map<string, () => void>();
  const authorized = (auth: AuthSession) =>
    hasPersistentRevocationAuthority() && isAuthSessionCurrent(auth);
  function target(sessionId: string, auth: AuthSession) {
    if (!authorized(auth))
      throw new SessionPromptError('Session authorization expired or was revoked.', 403);
    const meta = ctx.eventStore.getSession(sessionId);
    const binding = ctx.eventStore.getSessionRuntimeBinding(sessionId);
    const admission = ctx.eventStore.getLatestOrdinaryCommandAdmission(sessionId);
    const live = ctx.sessionRegistry.findBySessionId(sessionId);
    if (
      !isAvailableTelosWorkConversation(meta) ||
      !meta?.accountBinding ||
      binding?.version !== 2 ||
      !admission ||
      admission.state !== 'consumed' ||
      !isDeepStrictEqual(binding, admission.binding) ||
      meta.mode !== admission.selection.permission.mode ||
      meta.cwd !== admission.workspace.cwd ||
      (meta.ordinaryWorkspaceId ?? meta.repositoryWorkspaceId) !== admission.workspace.workspaceId
    )
      throw new SessionPromptError(
        'Open this ordinary session and send a message before scheduling work in it.',
        422,
      );
    // closedBy is retained history even after explicit reopening. A current
    // live owner may continue, but a timer cannot cold-resume that closure.
    if (
      (!live && meta.closedBy === 'user') ||
      (live &&
        (ctx.sessionRegistry.isUserClose(live.clientId) ||
          ctx.sessionRegistry.isClosingOut(live.clientId)))
    )
      throw new SessionPromptError(
        'The session was stopped. Open it before resuming scheduled work.',
        422,
      );
    if (
      live?.session.ordinaryRuntimeOwner?.authSessionId &&
      live.session.ordinaryRuntimeOwner.authSessionId !== auth.id &&
      binding.harness.implementation !== 'codex'
    )
      throw new SessionPromptError(
        'Open this session with your current login before scheduling work.',
        403,
      );
    return { meta, binding, admission, live };
  }
  return {
    authorized,
    async sessions(auth) {
      if (!authorized(auth)) throw new SessionPromptError('Sign in to view sessions.', 403);
      return ctx.eventStore.listSessions(1000).flatMap((meta) => {
        try {
          target(meta.sessionId, auth);
          return [{ sessionId: meta.sessionId, title: meta.summary || 'Untitled chat' }];
        } catch {
          return [];
        }
      });
    },
    async inspect(sessionId, auth) {
      const { meta } = target(sessionId, auth);
      return {
        busy:
          (!!meta.executionPhase && meta.executionPhase !== 'TERMINAL') ||
          ctx.eventStore.hasUncertainOrdinaryCommand(sessionId),
      };
    },
    receipt(delivery) {
      if (
        ctx.eventStore.getSendCommand(delivery.commandId)?.sessionId !== delivery.recipientSessionId
      )
        return 'absent';
      // Receipt observation must survive workspace transitions; it grants no
      // current execution authority and never causes a resend.
      return ctx.eventStore.readOrdinaryCommandExecutionEvidence(delivery.commandId)?.state ===
        'consumed'
        ? 'accepted'
        : 'uncertain';
    },
    async deliver(delivery, signal, assertCurrent) {
      const current = () => {
        signal.throwIfAborted();
        assertCurrent();
        target(delivery.recipientSessionId, delivery.auth);
      };
      current();
      const [entry, workspaces, library, profiles, dispatcher, shell, chat, vertex, openshell] =
        await Promise.all([
          import('./ordinary-local-codex-entry.js'),
          import('./repository-workspace-runtime.js'),
          import('./agent-library-runtime.js'),
          import('./ordinary-codex-agent-profile.js'),
          import('./ordinary-scoped-command.js'),
          import('./ordinary-openshell-codex-entry-owner.js'),
          import('./chat.js'),
          import('./ordinary-local-vertex-entry.js'),
          import('./ordinary-openshell-codex-entry.js'),
        ]);
      current();
      const { meta, binding, admission, live } = target(delivery.recipientSessionId, delivery.auth);
      if (!live) {
        const mayResume =
          binding.execution.location === 'openshell'
            ? openshell.canResumeOwnedOpenShellCodexDriver(meta.sessionId, delivery.auth.id)
            : binding.harness.implementation === 'claude-sdk'
              ? vertex.canResumeOwnedLocalVertexDriver(meta.sessionId, delivery.auth.id)
              : binding.harness.implementation === 'codex'
                ? chat.canResumeOwnedLocalCodexDriver(meta.sessionId, delivery.auth.id)
                : chat.canResumeOwnedLocalResponsesDriver(meta.sessionId, delivery.auth.id);
        if (!mayResume)
          throw new SessionPromptError(
            'The session needs attention before it can resume. Open the session, then resume its timer.',
            422,
          );
      }
      const { catalog, result } = entry.ordinaryRepositoryRuntimeInventory(
        binding.execution.location,
        binding.harness.implementation,
        binding,
        { conversationId: meta.sessionId, workspaceId: admission.workspace.workspaceId },
      );
      const runtime = {
        account: binding.account,
        harness: binding.harness.implementation,
        targetId: binding.execution.targetId,
        mode: admission.selection.permission.mode,
      };
      const resolved = catalog.resolve(runtime);
      if (resolved.status !== 'compatible' || !isDeepStrictEqual(resolved.binding, binding))
        throw new SessionPromptError(
          'The session runtime or account changed. Open it before resuming this timer.',
          422,
        );
      const profile = profiles.readOrdinaryCodexAgentProfile(
        library.getAgentLibrary(),
        admission.selection.agent,
      );
      if (!profile) throw new SessionPromptError('The session agent is unavailable.', 422);
      const ordinary = !!meta.ordinaryWorkspaceId;
      const workspace = ordinary
        ? workspaces
            .getOrdinaryWorkspaces(true)
            .getOrdinaryWorkspace(admission.workspace.workspaceId)
        : workspaces.getRepositoryWorkspaces(true).get(admission.workspace.workspaceId);
      const sandboxRepository = !ordinary && binding.execution.location === 'openshell';
      if (
        !workspace ||
        workspace.conversationId !== meta.sessionId ||
        (sandboxRepository
          ? !workspace.sandbox
          : workspace.directory !== admission.workspace.cwd || !workspace.hostReservation)
      )
        throw new SessionPromptError('The session workspace is unavailable.', 422);
      const taskRoot =
        workspace.hostReservation?.taskRoot ??
        (sandboxRepository && chat.BASE_REPO
          ? join(chat.BASE_REPO, '.claude', 'repository-tasks')
          : undefined);
      if (!taskRoot) throw new SessionPromptError('The session task root is unavailable.', 422);
      const operatorConnectionId = `session-prompt:${delivery.auth.id}:${meta.sessionId}`;
      if (!bindings.has(operatorConnectionId))
        bindings.set(
          operatorConnectionId,
          bindAgentLibraryTransport(operatorConnectionId, { ...delivery.auth }),
        );
      const transport = live?.session.transport ?? {
        isOpen: () => authorized(delivery.auth),
        send: (event: Record<string, unknown>) => ctx.connRegistry.broadcast(meta.sessionId, event),
      };
      current();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      try {
        current();
        await dispatcher.dispatchOwnedOrdinaryCommand({
          transport,
          clientId: live?.clientId ?? `session-prompt:${randomUUID()}:${meta.sessionId}`,
          sessionId: meta.sessionId,
          commandId: delivery.commandId,
          command: {
            clientMsgId: delivery.commandId,
            capabilityRevision: result.capabilityRevision,
            runtime,
            selection: admission.selection,
            payload: { text: sessionPromptText(delivery) },
          },
          reservation: {
            id: workspace.id,
            binding: meta.accountBinding!,
            conversationId: meta.sessionId,
            taskRoot,
            runtimeBinding: binding,
          },
          operatorConnectionId,
          ownerConnectionId: live?.session.ownerConnectionId ?? operatorConnectionId,
          ownerAuthSessionId: delivery.auth.id,
          signal: controller.signal,
          continuation: true,
          existingOwner: !!live,
          workspaceKind: ordinary ? 'ordinary' : 'repository',
          profile,
          ...(binding.execution.location === 'openshell'
            ? { sandboxWorkdir: shell.loadOrdinaryOpenShellCodexTarget()!.config.workdir }
            : {}),
        });
        if (
          ctx.eventStore.getSendCommand(delivery.commandId)?.sessionId !== meta.sessionId ||
          ctx.eventStore.getOrdinaryCommandAdmission(delivery.commandId)?.state !== 'consumed'
        )
          throw new SessionPromptError(
            'Prompt admission remains uncertain. Check the original delivery receipt.',
          );
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    close() {
      for (const release of bindings.values()) release();
      bindings.clear();
    },
  };
}
