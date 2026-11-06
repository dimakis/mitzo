import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationMessageInputSchema,
  type CollaborationMessageInput,
} from '@mitzo/protocol';
import type { SessionRegistry } from '@mitzo/harness';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { liveTransportAuthSessionId } from './transport-auth-ownership.js';
import { ordinaryRepositoryRuntimeInventory } from './ordinary-local-codex-entry.js';
import { dispatchOwnedOrdinaryCommand } from './ordinary-scoped-command.js';
import { reconcileApplicationCollaborationReplies } from './collaboration-application-replies.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import {
  assertCollaborationCommand,
  collaborationCommandId,
  collaborationCommandPayload,
  collaborationJoiningContext,
} from './collaboration-ordinary-command.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { EventStore } from './event-store.js';

function unavailable(): never {
  throw new CollaborationContractError('execution_unavailable');
}
/** One explicit ordinary recipient, using existing preparation, dispatcher,
 * receipt and finalized-reply owners. Fan-out/reader dispatch remains separate. */
export function createApplicationCollaborationMessages(owners: {
  store: EventStore;
  workspaces: () => RepositoryWorkspaces;
  registry: SessionRegistry;
  broadcast(sessionId: string, event: Record<string, unknown>): void;
  nativeStore?: () => CodexConversationStore | undefined;
}) {
  const { store, workspaces, registry } = owners;
  const view = (group: string) =>
    reconcileApplicationCollaborationReplies(store, group, owners.nativeStore);
  async function send(
    auth: AuthSession,
    clientId: string,
    group: string,
    raw: CollaborationMessageInput,
    signal: AbortSignal,
  ) {
    const operator = captureAgentLibraryAuthorization(clientId);
    const current = () => {
      signal.throwIfAborted();
      operator.assertCurrent();
      if (
        !isAuthSessionCurrent(auth) ||
        operator.auth.id !== auth.id ||
        liveTransportAuthSessionId(clientId) !== auth.id
      )
        unavailable();
    };
    current();
    const input = CollaborationMessageInputSchema.parse(raw);
    const previous = store.collaborationConversation.messageForRequest(group, input);
    if (previous) return previous;
    // This first delivery increment deliberately exposes only its qualified
    // explicit recipient path. It never drops an unimplemented attachment.
    if (
      input.responders.kind !== 'selected' ||
      input.responders.sessionIds.length !== 1 ||
      input.snapshot
    )
      unavailable();
    const sessionId = input.responders.sessionIds[0];
    if (
      store.collaborationConversation
        .view(group)
        .policies.some((policy) => policy.readsFutureDiscussion && policy.sessionId !== sessionId)
    )
      unavailable();
    const join = store.collaborationConversation.linkedJoinForSession(group, sessionId);
    if (!join) unavailable();
    const settings = store.getOrdinaryConversationSettings(sessionId);
    if (
      !settings ||
      !isDeepStrictEqual(settings, join.settings) ||
      settings.binding.harness.implementation !== 'codex' ||
      settings.binding.execution.location !== 'local' ||
      settings.selection.context.source !== 'none'
    )
      unavailable();
    const payload = collaborationCommandPayload(
      collaborationJoiningContext(store, group, join, auth.id),
      input.text,
    );
    const workspace = workspaces().get(settings.repositoryWorkspaceId);
    const meta = store.getSession(sessionId);
    const preparation = store.getOrdinarySessionPreparation(join.allocationOperationId);
    const live = registry.findBySessionId(sessionId);
    if (
      !meta ||
      meta.isHidden ||
      !meta.accountBinding ||
      !preparation ||
      !workspace.hostReservation ||
      workspace.conversationId !== sessionId ||
      (live && (registry.isUserClose(live.clientId) || registry.isClosingOut(live.clientId))) ||
      (!live && preparation.firstCommandId !== null && meta.closedBy === 'user')
    )
      unavailable();
    const { catalog, result } = ordinaryRepositoryRuntimeInventory(
      'local',
      'codex',
      settings.binding,
      { conversationId: sessionId, workspaceId: workspace.id },
    );
    const runtime = {
      account: settings.binding.account,
      harness: 'codex' as const,
      targetId: settings.binding.execution.targetId,
      mode: settings.selection.permission.mode,
    };
    const resolved = catalog.resolve(runtime);
    if (resolved.status !== 'compatible' || !isDeepStrictEqual(resolved.binding, settings.binding))
      unavailable();
    current();
    const accepted = store.collaborationConversation.acceptMessage(group, input);
    const message = store.collaborationConversation.getMessage(group, accepted.messageId)!;
    const delivery = message.deliveries.find(
      (row) => row.sessionId === sessionId && row.purpose === 'reply',
    );
    if (!delivery) unavailable();
    // Synchronous claim in the existing ledger precedes all dispatch awaits.
    // Uncertain is conservative until an exact native ACK, even if enqueue succeeds.
    if (delivery.status !== 'pending') return message;
    const commandId = collaborationCommandId(delivery.deliveryId);
    store.collaborationConversation.recordDelivery(group, message.messageId, delivery.deliveryId, {
      requestId: randomUUID(),
      expectedRevision: delivery.revision,
      status: 'uncertain',
      commandId,
      reason: 'Checking the original ordinary command acceptance; do not resend.',
    });
    const guard = () => {
      current();
      assertCollaborationCommand(store, sessionId, commandId, auth.id);
    };
    guard();
    try {
      await dispatchOwnedOrdinaryCommand({
        transport: live?.session.transport ?? {
          isOpen: () => isAuthSessionCurrent(auth),
          send: (event) => owners.broadcast(sessionId, event),
        },
        clientId: live?.clientId ?? `collaboration:${randomUUID()}`,
        sessionId,
        commandId,
        command: {
          clientMsgId: commandId,
          capabilityRevision: result.capabilityRevision,
          runtime,
          selection: settings.selection,
          payload,
        },
        reservation: {
          id: workspace.id,
          binding: meta.accountBinding,
          conversationId: sessionId,
          taskRoot: workspace.hostReservation.taskRoot,
          runtimeBinding: settings.binding,
          commandFingerprint: preparation.preparationFingerprint,
        },
        operatorConnectionId: clientId,
        ownerConnectionId: live?.session.ownerConnectionId ?? clientId,
        ownerAuthSessionId: auth.id,
        signal,
        continuation: preparation.firstCommandId !== null,
        existingOwner: !!live,
        workspaceKind: 'repository',
        ...(preparation.firstCommandId === null
          ? { preparationOperationId: join.allocationOperationId }
          : {}),
      });
    } catch {
      // Admission may have crossed an external boundary. Preserve the original
      // command and receipt; another HTTP retry only observes it.
      current();
    }
    return store.collaborationConversation.getMessage(group, message.messageId)!;
  }
  return { send, view };
}
