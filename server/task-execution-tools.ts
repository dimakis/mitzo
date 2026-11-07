import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import {
  captureAgentLibraryAuthorization,
  captureAgentLibraryOperation,
} from './agent-library-transport.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import { taskExecutionSchema } from './task-execution-definitions.js';
import { getTaskExecutionStore } from './task-execution-runtime.js';
import type { TaskExecutionScope, TaskExecutionStore } from './task-execution-store.js';
import { createLogger } from './logger.js';

import { assertTaskOperator, memberScope, publicGrant } from './task-execution-scope.js';
import { executeTaskOperation } from './task-execution-operation.js';
import { taskExecutionFailure, TaskExecutionRefusal } from './task-execution-failure.js';
import { retainCallbackOutcome } from './turn-callbacks.js';
import {
  captureTaskCapabilityConsent,
  currentTaskCapabilityConsent,
} from './task-capability-consent.js';
const log = createLogger('task-execution');
/** One host adapter for SDK/Vertex, Responses and native Local/OpenShell calls.
 * A grant ID is only a locator; signed operator and actual workspace identity
 * are independently checked on every call and before each effect.
 */
export function sessionTaskExecutionTools(options: {
  sessionId: string;
  session: ManagedSession;
  registry: SessionRegistry;
  prefix: string;
  store?: () => TaskExecutionStore;
  assertRuntimeCurrent?: () => Promise<void>;
  assertRuntimeCurrentSync?: () => void;
}) {
  return {
    async execute(
      raw: unknown,
      externalSignal: AbortSignal,
      call?: ProfileToolCall,
    ): Promise<{ content: string; isError: boolean }> {
      let operation: ReturnType<typeof captureAgentLibraryOperation> | undefined;
      let requestId: string | undefined;
      let operationName: string | undefined;
      let effectMayHaveStarted = false;
      try {
        const input = taskExecutionSchema.parse(raw);
        requestId = input.requestId;
        operationName = input.operation;
        const { session, sessionId, registry, prefix } = options;
        if (!options.assertRuntimeCurrent || !options.assertRuntimeCurrentSync)
          throw Error('Task execution requires a verified ordinary runtime owner');
        const owner = () => {
          externalSignal.throwIfAborted();
          session.abortController.signal.throwIfAborted();
          options.assertRuntimeCurrentSync!();
          const current = registry.findBySessionId(sessionId);
          if (
            !current ||
            current.session !== session ||
            registry.isClosingOut(current.clientId) ||
            registry.isUserClose(current.clientId) ||
            !agentToolAllowed(session, 'TaskExecution') ||
            checkSkillPolicy(registry, current.clientId, prefix + 'TaskExecution') === 'deny'
          )
            throw Error('Task execution owner, selection or skill policy changed');
          return current;
        };
        const source = owner();
        const connectionId = sessionToolOperatorConnection(source.session, source.clientId);
        const captured = captureAgentLibraryAuthorization(connectionId);
        assertTaskOperator(session, captured.auth.id);
        operation = captureAgentLibraryOperation(connectionId);
        const signal = AbortSignal.any([
          externalSignal,
          session.abortController.signal,
          operation.signal,
        ]);
        const current = () => {
          signal.throwIfAborted();
          operation!.assertCurrent();
          captured.assertCurrent();
          assertTaskOperator(session, captured.auth.id);
          const next = owner();
          if (sessionToolOperatorConnection(next.session, next.clientId) !== connectionId)
            throw Error('Task operator changed');
          return next;
        };
        await options.assertRuntimeCurrent();
        current();
        const store = (options.store ?? getTaskExecutionStore)();
        if (input.operation === 'status') {
          const grants = store
            .active(captured.auth.id, sessionId)
            .filter((grant) =>
              grant.members.some(
                (member) =>
                  member.sessionId === sessionId &&
                  member.fingerprint === memberScope(sessionId, session).fingerprint,
              ),
            );
          current();
          if (input.grantId && input.requestId) {
            store.inspectGrant(
              input.grantId,
              captured.auth.id,
              sessionId,
              memberScope(sessionId, session).fingerprint,
            );
            return {
              content: JSON.stringify({
                run: store.runStatus(input.grantId, sessionId, input.requestId),
              }),
              isError: false,
            };
          }
          return { content: JSON.stringify({ grants: grants.map(publicGrant) }), isError: false };
        }
        if (!call?.turnId || !call.callId)
          throw Error('Verified current task tool call is required');
        if (effectivePermissionMode(session) === 'ask')
          throw Error('Ask mode cannot execute or authorize task work');
        if (input.operation === 'authorize') {
          if (!input.requestId || !input.title)
            throw Error('Task authorization requires requestId and title');
          const memberIds = [...new Set([sessionId, ...(input.memberSessionIds ?? [])])].sort();
          const selectedMember = (id: string) => {
            const target = registry.findBySessionId(id);
            if (
              !target ||
              effectivePermissionMode(target.session) === 'ask' ||
              target.session.abortController.signal.aborted ||
              registry.isUserClose(target.clientId) ||
              registry.isClosingOut(target.clientId)
            )
              throw Error('Selected task worker is not live');
            const peerConnection = sessionToolOperatorConnection(target.session, target.clientId);
            const peer = captureAgentLibraryAuthorization(peerConnection);
            peer.assertCurrent();
            if (peer.auth.id !== captured.auth.id)
              throw Error('Selected task worker belongs to another operator');
            assertTaskOperator(target.session, captured.auth.id);
            return memberScope(id, target.session);
          };
          const members = memberIds.map(selectedMember);
          const storage = realpathSync(dirname(store.path));
          if (
            members.some((member) =>
              member.roots.some((root) => storage === root || storage.startsWith(root + '/')),
            )
          )
            throw Error('Task roots must not contain the controller authorization database');
          const previous = store.findApprovedRequest(captured.auth.id, sessionId, input.requestId);
          let scope: TaskExecutionScope = {
            title: input.title,
            network: input.network ?? 'none',
            durationMinutes: input.durationMinutes ?? 240,
            repositories: [...new Set(input.repositories ?? [])].sort(),
            members,
            expiresAt:
              previous?.expiresAt ??
              Math.min(
                captured.auth.expiresAt,
                Date.now() + (input.durationMinutes ?? 240) * 60_000,
              ),
          };
          const inherited = !previous ? captureTaskCapabilityConsent(registry, scope) : undefined;
          if (previous?.inheritedGrants)
            scope = { ...scope, inheritedGrants: previous.inheritedGrants };
          if (inherited)
            scope = {
              ...scope,
              inheritedGrants: inherited.inheritedGrants,
              expiresAt: inherited.expiresAt,
            };
          const assertScope = () => {
            current();
            inherited?.assertCurrent();
            if (scope.inheritedGrants)
              currentTaskCapabilityConsent(registry, scope).assertCurrent();
            if (!isDeepStrictEqual(members, memberIds.map(selectedMember)))
              throw Error('Selected task workspace scope changed during approval');
          };
          if (!previous && !inherited) {
            const display = {
              ...scope,
              permissions:
                'Run arbitrary project commands and local commits with writes confined to these host task roots. Ordinary host reads remain available except protected storage; GitHubRead uses only the listed repositories. Shell networking uses the displayed network scope. Credentials, merges and production are excluded.',
            };
            const decision = await buildPermissionHandler(source.clientId, registry)(
              prefix + 'TaskExecution',
              display,
              {
                signal,
                toolUseID: call.callId,
                forcePrompt: true,
                allowSessionGrant: false,
                rememberSessionGrant: false,
                approvalScope: 'request',
                title: 'Authorize this task and its selected workers?',
              },
            );
            assertScope();
            if (decision.behavior !== 'allow')
              throw new TaskExecutionRefusal('permission_denied', 'approval', decision.message);
            if (!isDeepStrictEqual(decision.updatedInput, display))
              throw Error('Task authorization input changed during approval');
          }
          assertScope();
          effectMayHaveStarted = true;
          const grant = store.approve(captured.auth.id, sessionId, input.requestId, scope);
          store.assertGrant(
            grant.id,
            captured.auth.id,
            sessionId,
            memberScope(sessionId, session).fingerprint,
          );
          log.info('Task authorization retained', {
            grantId: grant.id,
            sessionId,
            members: members.length,
          });
          return { content: JSON.stringify({ grant: publicGrant(grant) }), isError: false };
        }
        if (!input.grantId) throw Error('Task operation requires grantId');
        const assertGrant = () => {
          current();
          if (effectivePermissionMode(session) === 'ask')
            throw Error('Task execution is blocked by Ask mode');
          const authorized = store.assertGrant(
            input.grantId!,
            captured.auth.id,
            sessionId,
            memberScope(sessionId, session).fingerprint,
          );
          currentTaskCapabilityConsent(registry, authorized, sessionId).assertCurrent();
          return authorized;
        };
        const grant = assertGrant();
        if (input.operation === 'revoke') {
          effectMayHaveStarted = true;
          store.revoke(grant.id, captured.auth.id, sessionId);
          log.info('Task authorization revoked', { grantId: grant.id, sessionId });
          return { content: JSON.stringify({ grantId: grant.id, revoked: true }), isError: false };
        }
        return await executeTaskOperation({
          input,
          grant,
          sessionId,
          session,
          registry,
          clientId: current().clientId,
          call,
          store,
          signal: AbortSignal.any([
            signal,
            currentTaskCapabilityConsent(registry, grant, sessionId).signal,
          ]),
          assertGrant,
          assertRuntimeCurrent: options.assertRuntimeCurrent,
          onDispatch: () => {
            effectMayHaveStarted = true;
          },
        });
      } catch (error) {
        const failure = taskExecutionFailure(
          error,
          operationName,
          requestId,
          effectMayHaveStarted,
          externalSignal.aborted || options.session.abortController.signal.aborted,
        );
        log.warn('Task execution refused or failed', {
          sessionId: options.sessionId,
          operation: failure.operation,
          requestId,
          code: failure.code,
          effectStatus: failure.effectStatus,
          cause: failure.error,
        });
        return retainCallbackOutcome(
          {
            content: JSON.stringify(failure),
            isError: true,
          },
          failure.effectStatus === 'not_started' ? 'settled' : 'unknown',
        );
      } finally {
        operation?.dispose();
      }
    },
  };
}
