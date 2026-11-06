import { isDeepStrictEqual } from 'node:util';
import {
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { SessionTimerChangeSchema } from '@mitzo/protocol';
import { agentToolAllowed } from './agent-tool-selection.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { buildPermissionHandler } from './permission-handler.js';
import { sessionPromptSchemas } from './session-prompt-definitions.js';
import { getSessionPrompts } from './session-prompt-runtime.js';
import { sessionPromptReceipt } from './session-prompt-service.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import { retainedNativeHostToolOperator } from './native-host-tool-operator.js';
import { sessionTaskExecutionTools } from './task-execution-tools.js';

export function sessionPromptTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  prefix: string,
  assertRuntimeCurrent?: () => Promise<void>,
  assertRuntimeCurrentSync?: () => void,
) {
  const tasks = sessionTaskExecutionTools({
    sessionId,
    session,
    registry,
    prefix,
    assertRuntimeCurrent,
    assertRuntimeCurrentSync,
  });
  return {
    async execute(
      name: string,
      input: Record<string, unknown>,
      externalSignal: AbortSignal,
      call?: ProfileToolCall,
    ) {
      if (!Object.hasOwn(sessionPromptSchemas, name)) return undefined;
      if (name === 'TaskExecution') return tasks.execute(input, externalSignal, call);
      try {
        if (!assertRuntimeCurrent || !assertRuntimeCurrentSync)
          throw Error('Session automation requires a current ordinary runtime owner.');
        const signal = AbortSignal.any([externalSignal, session.abortController.signal]);
        const current = () => {
          signal.throwIfAborted();
          assertRuntimeCurrentSync();
          const owner = registry.findBySessionId(sessionId);
          if (
            !owner ||
            owner.session !== session ||
            !agentToolAllowed(session, name) ||
            checkSkillPolicy(registry, owner.clientId, prefix + name) === 'deny'
          )
            throw Error('This session can no longer use this tool.');
          return owner;
        };
        const owner = current();
        const connectionId =
          retainedNativeHostToolOperator(owner.session) ??
          owner.session.ownerConnectionId ??
          owner.clientId.split(':')[0];
        const captured = captureAgentLibraryAuthorization(connectionId);
        const verify = () => {
          const next = current();
          captured.assertCurrent();
          if (
            (retainedNativeHostToolOperator(next.session) ??
              next.session.ownerConnectionId ??
              next.clientId.split(':')[0]) !== connectionId
          )
            throw Error('Session operator changed.');
        };
        verify();
        await assertRuntimeCurrent();
        verify();
        const parsed = sessionPromptSchemas[name as keyof typeof sessionPromptSchemas].parse(input);
        const read =
          name === 'SessionTimers' &&
          'operation' in parsed &&
          ['list', 'sessions', 'read', 'delivery'].includes(parsed.operation);
        if (!read) {
          if (!call?.turnId || !call.callId) throw Error('Verified current tool call required.');
          if (effectivePermissionMode(session) === 'ask')
            throw Error('Ask mode cannot schedule prompts or send peer messages.');
          const decision = await buildPermissionHandler(owner.clientId, registry)(
            prefix + name,
            input,
            { signal, toolUseID: call.callId },
          );
          verify();
          if (
            decision.behavior !== 'allow' ||
            !isDeepStrictEqual(decision.updatedInput ?? input, input)
          )
            throw Error('The exact timer or message was not approved.');
        }
        const service = getSessionPrompts();
        let value: unknown;
        if (name === 'SchedulePrompt') {
          const schedule = sessionPromptSchemas.SchedulePrompt.parse(parsed);
          value = await service.create(
            { ...schedule, sessionId: schedule.sessionId ?? sessionId },
            captured.auth,
            'agent',
            sessionId,
            verify,
          );
        } else if (name === 'SendSessionMessage') {
          value = await service.send(parsed, captured.auth, sessionId, verify);
        } else {
          const operation = sessionPromptSchemas.SessionTimers.parse(parsed);
          if (operation.operation === 'list') value = service.list(operation.sessionId);
          else if (operation.operation === 'sessions')
            value = await service.sessions(captured.auth);
          else if (operation.operation === 'delivery') {
            if (!operation.deliveryId) throw Error('deliveryId is required.');
            const delivery = service.store.delivery(operation.deliveryId);
            if (![delivery.senderSessionId, delivery.recipientSessionId].includes(sessionId))
              throw Error('This message belongs to another session.');
            value = sessionPromptReceipt(delivery);
          } else {
            if (!operation.timerId) throw Error('timerId is required.');
            if (operation.operation === 'read') value = service.store.get(operation.timerId);
            else {
              verify();
              value = service.change(
                operation.timerId,
                SessionTimerChangeSchema.parse({
                  requestId: operation.requestId,
                  expectedRevision: operation.expectedRevision,
                  action: operation.operation,
                  prompt: operation.prompt,
                  intervalMinutes: operation.intervalMinutes,
                  maxRuns: operation.maxRuns,
                }),
                captured.auth,
              );
            }
          }
        }
        verify();
        return { content: JSON.stringify(value), isError: false };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : 'Session automation is unavailable.',
          isError: true,
        };
      }
    },
  };
}
