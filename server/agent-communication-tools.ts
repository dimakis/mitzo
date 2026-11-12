import { retainCallbackOutcome, copyCallbackOutcome } from './turn-callbacks.js';
import { z } from 'zod';
import { waitForChange } from './wait-for-change.js';
import { isDeepStrictEqual } from 'node:util';
import { AgentMessageSendSchema, agentMessagePrompt, type AgentMessage } from '@mitzo/protocol';
import { checkSkillPolicy, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import {
  captureAgentLibraryAuthorization,
  captureAgentLibraryOperation,
} from './agent-library-transport.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import type { EventStore } from './event-store.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import type { AccountBinding } from '@mitzo/protocol';
import { createLogger } from './logger.js';
import {
  agentMessageRuntime,
  hasAgentMessageRuntime,
  AgentCommunicationError,
  agentCommunicationDiagnostic,
} from './agent-message-runtime.js';
const log = createLogger('agent-communication');

/** The successful cancellation boundary owns projection even without a live
 * conversation. A receipt lookup by another agent must never be required. */
export function cancelCommandWithAgentReceipt<T extends string>(
  events: EventStore,
  native: CodexConversationStore,
  conversationId: string,
  account: AccountBinding,
  commandId: string,
  cancel: () => T,
): T {
  const result = cancel();
  if (result === 'cancelled') {
    const retained = events.agentCommunication.forCommand(commandId);
    if (retained)
      recordAgentMessageCommandOutcome(
        events,
        native,
        conversationId,
        account,
        retained.operatorAuthSessionId,
        commandId,
      );
  }
  return result;
}

export function recordAgentMessageCommandOutcome(
  events: EventStore,
  native: CodexConversationStore,
  conversationId: string,
  account: AccountBinding,
  authSessionId: string | undefined,
  commandId: string,
): boolean {
  const peer = events.agentCommunication.forCommand(commandId);
  if (
    !peer ||
    peer.message.recipientConversationId !== conversationId ||
    peer.operatorAuthSessionId !== authSessionId
  )
    return false;
  let reason: 'cancelled' | 'before_provider_submission';
  try {
    const status = native.commandStatus(conversationId, account, commandId);
    if (status === 'cancelled') reason = 'cancelled';
    else if (
      status === 'failed' &&
      native.assertUndispatchedCommand(conversationId, account, commandId)
    )
      reason = 'before_provider_submission';
    else return false;
  } catch {
    return false;
  }
  events.agentCommunication.recordForHost(peer.message.messageId, 'failed', reason);
  return true;
}

export function recordAgentMessageAcceptance(
  events: EventStore,
  native: CodexConversationStore,
  conversationId: string,
  account: AccountBinding,
  authSessionId: string | undefined,
  commandId: string,
  threadId: string,
  turnId: string,
) {
  const peer = events.agentCommunication.forCommand(commandId);
  if (!peer) return;
  const ack = native.acceptedProviderTurnForCommand(
    conversationId,
    account,
    commandId,
    agentMessagePrompt(peer.message),
  );
  if (
    peer.message.recipientConversationId !== conversationId ||
    peer.operatorAuthSessionId !== authSessionId ||
    ack?.threadId !== threadId ||
    ack.turnId !== turnId
  )
    throw Error('Agent message native acknowledgement changed');
  events.agentCommunication.recordForHost(peer.message.messageId, 'delivered');
}

export const AGENT_COMMUNICATION_TOOL = 'AgentCommunication';
export const AgentCommunicationInput = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('list'),
    offset: z.number().int().min(0).max(1000).default(0),
  }),
  z.strictObject({
    operation: z.literal('inbox'),
    after: z.number().int().nonnegative().safe().default(0),
  }),
  z.strictObject({
    operation: z.literal('wait'),
    after: z.number().int().nonnegative().safe().default(0),
    timeoutMs: z.number().int().min(1).max(30000).default(20000),
  }),
  z.strictObject({ operation: z.literal('read'), messageId: z.uuid() }),
  z.strictObject({ operation: z.literal('lookup'), requestId: z.uuid() }),
  AgentMessageSendSchema.extend({ operation: z.literal('send') }),
]);
/** SDK MCP accepts a field shape; the discriminated schema above remains the
 * final operation-specific validator at the shared owner boundary. */
export const AgentCommunicationSdkInput = z.strictObject({
  ...AgentMessageSendSchema.partial().shape,
  operation: z.enum(['list', 'inbox', 'wait', 'read', 'lookup', 'send']),
  offset: z.number().int().min(0).max(1000).optional(),
  after: z.number().int().nonnegative().safe().optional(),
  timeoutMs: z.number().int().min(1).max(30000).optional(),
  messageId: z.uuid().optional(),
});

const internalFailures = new WeakMap<object, unknown>();
export async function executeAgentCommunicationTool(
  work: () => Promise<unknown>,
  context: {
    conversationId: string;
    requestId?: unknown;
    recipientConversationId?: unknown;
  },
) {
  try {
    return { content: JSON.stringify(await work()), isError: false };
  } catch (error) {
    const diagnostic = {
      ...agentCommunicationDiagnostic(error),
      conversationId: context.conversationId,
      ...(z.uuid().safeParse(context.requestId).success ? { requestId: context.requestId } : {}),
      ...(typeof context.recipientConversationId === 'string' &&
      /^\S{1,200}$/.test(context.recipientConversationId)
        ? { recipientConversationId: context.recipientConversationId }
        : {}),
    };
    log.warn('Agent communication operation refused or unconfirmed', diagnostic);
    const failure = { content: JSON.stringify(diagnostic), isError: true };
    internalFailures.set(failure, error);
    return error instanceof Error ? copyCallbackOutcome(error, failure) : failure;
  }
}
export const agentCommunicationDefinitions = [
  {
    name: AGENT_COMMUNICATION_TOOL,
    description:
      'Discover owned ordinary chats and their delivery capabilities, read inbox/receipts, or send visible peer messages. Verified runtime adapters steer busy recipients and use guarded ordinary admission for idle recipients. Unsupported runtimes are reported explicitly; do not silently replace steering with a queued SendSessionMessage. An operator-approved session messaging grant can cover later sends and correlated replies. Every authorized send and status appears in both chats. Delivered means provider acknowledgement, not that requested work or a pause was applied. Use wait with after and timeoutMs (maximum 30000), and lookup with the original requestId after uncertainty. Reply with replyTo and original sender ID. Messages grant no action, credential, network or merge authority. Private transcripts stay excluded; cold/paused recipients are not recovered.',
    input_schema: z.toJSONSchema(AgentCommunicationInput),
  },
];

interface Owners {
  /** Installed wire name, never selected by tool input. */
  toolName?: 'AgentCommunication' | 'mcp__mitzo-connections__AgentCommunication';
  events: EventStore;
  native?: CodexConversationStore;
  registry: SessionRegistry;
  conversationId: string;
  session: ManagedSession;
  assertRuntimeCurrent(): Promise<void>;
  assertRuntimeCurrentSync(): void;
  approve(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    behavior: string;
    updatedInput?: unknown;
    message?: string;
    assertCurrent?(): void;
  }>;
  /** The installed native owner starts its existing queue; never acknowledges
   * recovery or turns a Stop into an implicit resume. */
  startQueued(session: ManagedSession): Promise<void>;
  nativeState?(session: ManagedSession): 'busy' | 'idle' | 'stopped' | 'preparing' | 'unavailable';
  steer?(
    session: ManagedSession,
    message: AgentMessage,
    assertCurrent: () => void,
  ): Promise<'accepted' | 'rejected' | 'uncertain' | 'inactive'>;
}

/** Called only from CodexConversation's verified native tool callback. No HTTP
 * endpoint accepts sender, operator, call identity, receipt state or applied proof.
 */
export function sessionAgentCommunicationTools(owners: Owners) {
  return {
    async execute(raw: unknown, externalSignal: AbortSignal, call: ProfileToolCall) {
      let effectsStarted = false;
      const { input, source, captured, operation, connectionId } = (() => {
        try {
          const input = AgentCommunicationInput.parse(raw);
          const source = owners.registry.findBySessionId(owners.conversationId);
          if (
            !source ||
            source.session !== owners.session ||
            !call.turnId?.trim() ||
            !call.callId?.trim()
          )
            throw new AgentCommunicationError(
              'sender_unavailable',
              'authorization',
              'A verified current sender is required.',
            );
          const connectionId = sessionToolOperatorConnection(source.session, source.clientId);
          const captured = captureAgentLibraryAuthorization(connectionId);
          const operation = captureAgentLibraryOperation(connectionId);
          return { input, source, captured, operation, connectionId };
        } catch (error) {
          if (error instanceof Error && !externalSignal.aborted)
            retainCallbackOutcome(error, 'settled');
          throw error;
        }
      })();
      const signal = AbortSignal.any([
        externalSignal,
        operation.signal,
        owners.session.abortController.signal,
      ]);
      const sourceOwner = source.session.ordinaryRuntimeOwner;
      const current = () => {
        signal.throwIfAborted();
        operation.assertCurrent();
        owners.assertRuntimeCurrentSync();
        const now = owners.registry.findBySessionId(owners.conversationId);
        if (
          !hasPersistentRevocationAuthority() ||
          now?.session !== source.session ||
          now.clientId !== source.clientId ||
          now.session.ordinaryRuntimeOwner !== sourceOwner ||
          sessionToolOperatorConnection(now.session, now.clientId) !== connectionId ||
          sourceOwner?.authSessionId !== captured.auth.id ||
          !agentToolAllowed(owners.session, owners.toolName ?? AGENT_COMMUNICATION_TOOL) ||
          checkSkillPolicy(
            owners.registry,
            source.clientId,
            owners.toolName ?? AGENT_COMMUNICATION_TOOL,
          ) === 'deny' ||
          owners.registry.isClosingOut(source.clientId) ||
          owners.registry.isUserClose(source.clientId)
        )
          throw new AgentCommunicationError(
            'sender_authority_changed',
            'authorization',
            'The original signed sender authority changed.',
          );
      };
      const eligible = (conversationId: string) => {
        const meta = owners.events.getSession(conversationId);
        const binding = owners.events.getSessionRuntimeBinding(conversationId);
        if (
          !isAvailableTelosWorkConversation(meta) ||
          !meta?.accountBinding ||
          binding?.version !== 2 ||
          (binding.harness.implementation === 'codex' && binding.execution.location === 'local'
            ? !owners.native?.hasConversation(conversationId) ||
              owners.native.readHostCustody(conversationId, meta.accountBinding)?.authSessionId !==
                captured.auth.id
            : owners.registry.findBySessionId(conversationId)?.session.ordinaryRuntimeOwner
                ?.authSessionId !== captured.auth.id)
        )
          throw new AgentCommunicationError(
            'recipient_unavailable',
            'ownership',
            'The recipient is unavailable to this signed operator.',
          );
        return meta;
      };
      const liveRecipient = (conversationId: string) => {
        const target = owners.registry.findBySessionId(conversationId);
        const driver = target?.session.ordinaryRuntimeOwner;
        const binding = owners.events.getSessionRuntimeBinding(conversationId);
        const native =
          binding?.harness.implementation === 'codex' && binding.execution.location === 'local';
        return target &&
          driver &&
          (!native || driver.admitAgentMessage || hasAgentMessageRuntime(target.session)) &&
          driver.authSessionId === captured.auth.id &&
          !target.session.abortController.signal.aborted &&
          !owners.registry.isClosingOut(target.clientId) &&
          !owners.registry.isUserClose(target.clientId)
          ? target
          : undefined;
      };
      const capability = (conversationId: string) => {
        const binding = owners.events.getSessionRuntimeBinding(conversationId)!;
        const target = liveRecipient(conversationId);
        const adapter = target && agentMessageRuntime(target.session, captured.auth.id);
        const native =
          binding.harness.implementation === 'codex' && binding.execution.location === 'local';
        return {
          runtime: binding.harness.implementation,
          activeDelivery: adapter || (native && owners.steer) ? 'steer' : 'unsupported',
          idleDelivery:
            adapter?.enqueue || (native && target?.session.ordinaryRuntimeOwner?.admitAgentMessage)
              ? 'queue'
              : 'unsupported',
          state:
            adapter?.state() ??
            (native && target
              ? (owners.nativeState?.(target.session) ?? 'unknown')
              : target
                ? 'unknown'
                : 'unavailable'),
          reason:
            adapter ||
            (native && (owners.steer || target?.session.ordinaryRuntimeOwner?.admitAgentMessage))
              ? null
              : 'runtime_unsupported',
        };
      };
      const assertSupported = (conversationId: string) => {
        const info = capability(conversationId);
        if (info.state === 'preparing')
          throw new AgentCommunicationError(
            'recipient_preparing',
            'capability',
            'The recipient has not acknowledged an active input yet. Wait for command admission before steering.',
          );
        if (info.state === 'stopped')
          throw new AgentCommunicationError(
            'recipient_stopped',
            'capability',
            'The recipient is stopped. Open it and explicitly resume before sending new work.',
          );
        if (info.activeDelivery === 'unsupported' && info.idleDelivery === 'unsupported')
          throw new AgentCommunicationError(
            'runtime_unsupported',
            'capability',
            'This runtime has no verified peer-message adapter. SendSessionMessage can queue a separate prompt after its active work ends; queueing does not steer or pause that work.',
          );
      };
      const reconcile = (message: AgentMessage) => {
        // This path can update an existing delivery receipt.
        effectsStarted = true;
        const retained = owners.events.agentCommunication.forHost(message.messageId);
        if (retained.operatorAuthSessionId !== captured.auth.id)
          throw Error('Original signed operator required');
        // Current sender/participant/operator authority protects retained facts.
        // Losing a recipient's new-send eligibility cannot erase that history.
        let target;
        try {
          target = eligible(message.recipientConversationId);
        } catch (error) {
          if (!(error instanceof AgentCommunicationError) || error.code !== 'recipient_unavailable')
            throw error;
          return owners.events.agentCommunication.read(owners.conversationId, message.messageId);
        }
        const binding = owners.events.getSessionRuntimeBinding(target.sessionId);
        if (
          !owners.native ||
          binding?.harness.implementation !== 'codex' ||
          binding.execution.location !== 'local'
        )
          return owners.events.agentCommunication.read(owners.conversationId, message.messageId);
        const ack = owners.native.acceptedProviderTurnForCommand(
          target.sessionId,
          target.accountBinding!,
          message.commandId,
          agentMessagePrompt(message),
        );
        const steering = owners.native.steeringReceiptForRequest(
          target.sessionId,
          target.accountBinding!,
          message.commandId,
        );
        if (steering && steering.input.text !== agentMessagePrompt(message))
          throw Error('Agent steering identity changed');
        if (ack || steering?.status === 'accepted')
          owners.events.agentCommunication.recordForHost(message.messageId, 'delivered');
        else if (steering) {
          owners.events.agentCommunication.recordForHost(
            message.messageId,
            steering.status === 'rejected' ? 'failed' : 'uncertain',
            steering.status === 'rejected' ? 'steering_rejected' : 'admission_uncertain',
          );
        } else {
          const status = owners.native.commandStatus(
            target.sessionId,
            target.accountBinding!,
            message.commandId,
          );
          if (status === 'cancelled')
            owners.events.agentCommunication.recordForHost(
              message.messageId,
              'failed',
              'cancelled',
            );
          else if (
            status === 'failed' &&
            recordAgentMessageCommandOutcome(
              owners.events,
              owners.native,
              target.sessionId,
              target.accountBinding!,
              captured.auth.id,
              message.commandId,
            )
          ) {
            // Positive live-owner evidence proves that the provider was never invoked.
          } else if (status && ['running', 'failed', 'interrupted', 'completed'].includes(status))
            owners.events.agentCommunication.recordForHost(
              message.messageId,
              'uncertain',
              'admission_uncertain',
            );
        }
        return owners.events.agentCommunication.read(owners.conversationId, message.messageId);
      };
      try {
        current();
        eligible(owners.conversationId);
        await owners.assertRuntimeCurrent();
        current();
        if (input.operation === 'list') {
          // No prompt, path, account detail, provider identity or private history.
          const chats = owners.events.listSessions(1000).flatMap((meta) => {
            if (meta.sessionId === owners.conversationId) return [];
            try {
              eligible(meta.sessionId);
            } catch (error) {
              if (
                error instanceof AgentCommunicationError &&
                error.code === 'recipient_unavailable'
              )
                return [];
              throw error;
            }
            let info: ReturnType<typeof capability>;
            try {
              info = capability(meta.sessionId);
            } catch (error) {
              log.warn('Known peer runtime capability unavailable', {
                ...agentCommunicationDiagnostic(error),
                stage: 'capability',
                conversationId: meta.sessionId,
              });
              info = {
                runtime: owners.events.getSessionRuntimeBinding(meta.sessionId)!.harness
                  .implementation,
                activeDelivery: 'unsupported',
                idleDelivery: 'unsupported',
                state: 'unavailable',
                reason: 'runtime_authority_unavailable',
              };
            }
            return [
              {
                conversationId: meta.sessionId,
                summary: meta.summary,
                availability:
                  liveRecipient(meta.sessionId) && info.state !== 'unavailable'
                    ? 'live'
                    : 'unavailable',
                capability: info,
              },
            ];
          });
          current();
          return {
            chats: chats.slice(input.offset, input.offset + 50),
            nextOffset: chats.length > input.offset + 50 ? input.offset + 50 : null,
          };
        }
        if (input.operation === 'wait') {
          const result = await waitForChange({
            signal,
            timeoutMs: input.timeoutMs,
            subscribe: (wake) =>
              owners.events.agentCommunication.subscribe(owners.conversationId, wake),
            read: () => {
              current();
              eligible(owners.conversationId);
              return owners.events.agentCommunication.inbox(owners.conversationId, input.after);
            },
            changed: (page) => page.messages.length > 0,
          });
          await owners.assertRuntimeCurrent();
          current();
          return {
            changed: result.changed,
            ...result.value,
            messages: result.value.messages.map(reconcile),
          };
        }
        if (input.operation === 'inbox') {
          const page = owners.events.agentCommunication.inbox(owners.conversationId, input.after);
          return { ...page, messages: page.messages.map(reconcile) };
        }
        if (input.operation === 'read')
          return reconcile(
            owners.events.agentCommunication.read(owners.conversationId, input.messageId),
          );
        if (input.operation === 'lookup')
          return reconcile(
            owners.events.agentCommunication.byRequest(owners.conversationId, input.requestId),
          );
        const send = {
          requestId: input.requestId,
          recipientConversationId: input.recipientConversationId,
          text: input.text,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        };
        // Exact retries only inspect already-authorized immutable work. They do
        // not ask again, re-admit, or require the recipient to remain live.
        if (owners.events.agentCommunication.findRequest(owners.conversationId, input.requestId)) {
          effectsStarted = true;
          return reconcile(
            owners.events.agentCommunication.reserve(
              owners.conversationId,
              captured.auth.id,
              call,
              send,
            ),
          );
        }
        eligible(input.recipientConversationId);
        if (!liveRecipient(input.recipientConversationId))
          throw new AgentCommunicationError(
            'recipient_unavailable',
            'ownership',
            'The recipient has no current live owner. Open it explicitly before sending a new message.',
          );
        assertSupported(input.recipientConversationId);
        const permission = await owners.approve(input, signal);
        current();
        if (permission.behavior !== 'allow' || !isDeepStrictEqual(permission.updatedInput, input))
          throw new AgentCommunicationError(
            'approval_denied',
            'approval',
            'The exact peer message was not approved.',
          );
        await owners.assertRuntimeCurrent();
        current();
        permission.assertCurrent?.();
        eligible(input.recipientConversationId);
        if (!liveRecipient(input.recipientConversationId))
          throw new AgentCommunicationError(
            'recipient_unavailable',
            'ownership',
            'The recipient has no current live owner. Open it explicitly before sending a new message.',
          );
        assertSupported(input.recipientConversationId);
        effectsStarted = true;
        const message = owners.events.agentCommunication.reserve(
          owners.conversationId,
          captured.auth.id,
          call,
          send,
        );
        if (message.status !== 'pending') return reconcile(message);
        const target = owners.registry.findBySessionId(input.recipientConversationId);
        const driver = target?.session.ordinaryRuntimeOwner;
        if (
          !target ||
          !driver ||
          driver.authSessionId !== captured.auth.id ||
          target.session.abortController.signal.aborted ||
          owners.registry.isClosingOut(target.clientId) ||
          owners.registry.isUserClose(target.clientId)
        ) {
          owners.events.agentCommunication.recordForHost(
            message.messageId,
            'unavailable',
            'recipient_unavailable',
          );
          return owners.events.agentCommunication.read(owners.conversationId, message.messageId);
        }
        const assertAdmissionCurrent = () => {
          current();
          permission.assertCurrent?.();
          eligible(input.recipientConversationId);
          const live = owners.registry.findBySessionId(input.recipientConversationId);
          if (
            live?.session !== target.session ||
            live.clientId !== target.clientId ||
            live.session.ordinaryRuntimeOwner !== driver ||
            live.session.abortController.signal.aborted ||
            owners.registry.isClosingOut(live.clientId) ||
            owners.registry.isUserClose(live.clientId)
          )
            throw Error('Recipient owner changed during admission');
        };
        assertAdmissionCurrent();
        if (!owners.events.agentCommunication.claim(message.messageId)) return reconcile(message);
        try {
          const adapter = agentMessageRuntime(target.session, captured.auth.id);
          if (adapter) {
            const result =
              adapter.state() === 'busy'
                ? await adapter.steer(message, assertAdmissionCurrent, signal)
                : adapter.state() === 'idle' && adapter.enqueue
                  ? await adapter.enqueue(message, assertAdmissionCurrent, signal, captured.auth)
                  : 'rejected';
            if (result === 'accepted')
              owners.events.agentCommunication.recordForHost(message.messageId, 'delivered');
            else if (
              result === 'queued' &&
              owners.events.agentCommunication.forHost(message.messageId).message.status !==
                'delivered'
            )
              owners.events.agentCommunication.recordForHost(message.messageId, 'queued');
            else if (result === 'rejected' || result === 'inactive')
              owners.events.agentCommunication.recordForHost(
                message.messageId,
                'failed',
                'steering_rejected',
              );
            assertAdmissionCurrent();
            return reconcile(message);
          }
          const steering = await owners.steer?.(target.session, message, assertAdmissionCurrent);
          if (steering && steering !== 'inactive') {
            if (steering === 'rejected')
              owners.events.agentCommunication.recordForHost(
                message.messageId,
                'failed',
                'steering_rejected',
              );
            assertAdmissionCurrent();
            return reconcile(message);
          }
          assertAdmissionCurrent();
          if (!driver.admitAgentMessage)
            throw new AgentCommunicationError(
              'runtime_unsupported',
              'delivery',
              'The recipient has no guarded peer-message queue.',
            );
          const result = await driver.admitAgentMessage(
            message.messageId,
            assertAdmissionCurrent,
            signal,
            permission.assertCurrent,
          );
          assertAdmissionCurrent();
          if (result.dispatched) {
            owners.events.agentCommunication.recordForHost(message.messageId, 'queued');
            await owners.startQueued(target.session);
            current();
          }
        } catch (error) {
          // Claim is already uncertain. Only an exact native ACK may repair
          // delivery, never a second enqueue or optimistic success response.
          current();
          log.warn('Agent message delivery not confirmed', {
            ...agentCommunicationDiagnostic(error),
            messageId: message.messageId,
            commandId: message.commandId,
            senderConversationId: message.senderConversationId,
            recipientConversationId: message.recipientConversationId,
          });
        }
        return reconcile(
          owners.events.agentCommunication.read(owners.conversationId, message.messageId),
        );
      } catch (error) {
        if (error instanceof Error && !effectsStarted && !externalSignal.aborted)
          retainCallbackOutcome(error, 'settled');
        throw error;
      } finally {
        operation.dispose();
      }
    },
  };
}
