import { z } from 'zod';
import { MemoryCandidateInputSchema } from '@mitzo/protocol';
import { checkSkillPolicy, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { sessionToolOperatorConnection } from './native-host-tool-operator.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import { createLogger } from './logger.js';

const log = createLogger('session-learning');
export const learningToolSchemas = {
  CaptureMemoryCandidate: z.strictObject({
    action: z.enum(['sources', 'capture']),
    beforeSeq: z.number().int().positive().safe().optional(),
    candidate: MemoryCandidateInputSchema.optional(),
  }),
};
export const learningToolDefinitions = [
  {
    name: 'CaptureMemoryCandidate',
    description:
      'Preserve a sourced provisional learning candidate from this conversation. First use action sources for eligible public message identifiers, then capture with candidate and a stable UUID requestId. Returns stored only after durable commit. Retry the exact payload after interruption. Off blocks capture, including explicit remember-this requests. Does not enroll sources/accounts/audiences, change mode, accept knowledge or publish. Sources are metadata only; beforeSeq pages earlier identifiers.',
    input_schema: z.toJSONSchema(learningToolSchemas.CaptureMemoryCandidate),
  },
];
let runtime: EventStore | undefined;
/** Installed by controller composition, never selected by a model or task file. */
export function installSessionLearningRuntime(store: EventStore) {
  const previous = runtime;
  runtime = store;
  return () => {
    if (runtime === store) runtime = previous;
  };
}
const knownFailures = new Set([
  'learning_off',
  'learning_request_conflict',
  'source_excluded',
  'source_ineligible',
  'source_changed',
  'learning_session_unavailable',
  'learning_authority_unavailable',
  'learning_runtime_unavailable',
  'invalid_candidate',
]);
export function sessionLearningTools(
  sessionId: string,
  session: ManagedSession,
  registry: SessionRegistry,
  prefix = '',
  assertRuntimeCurrent?: () => Promise<void>,
  assertRuntimeCurrentSync?: () => void,
) {
  return {
    async execute(name: string, input: Record<string, unknown>, signal: AbortSignal) {
      if (name !== 'CaptureMemoryCandidate') return undefined;
      try {
        const selected = runtime;
        const owner = registry.findBySessionId(sessionId);
        if (!owner || owner.session !== session) throw Error('learning_authority_unavailable');
        const connection = sessionToolOperatorConnection(session, owner.clientId);
        const authority = captureAgentLibraryAuthorization(connection);
        const account = JSON.stringify(session.accountBinding);
        const assert = () => {
          signal.throwIfAborted();
          session.abortController.signal.throwIfAborted();
          assertRuntimeCurrentSync?.();
          authority.assertCurrent();
          const current = registry.findBySessionId(sessionId);
          if (
            !current ||
            current.session !== session ||
            registry.get(current.clientId) !== session ||
            sessionToolOperatorConnection(session, current.clientId) !== connection ||
            JSON.stringify(session.accountBinding) !== account ||
            runtime !== selected ||
            !agentToolAllowed(session, name) ||
            checkSkillPolicy(registry, current.clientId, prefix + name) === 'deny'
          )
            throw Error('learning_authority_unavailable');
          if (!selected) throw Error('learning_runtime_unavailable');
          const persisted = selected.getSession(sessionId);
          if (
            !persisted ||
            persisted.cwd !== session.cwd ||
            (persisted.accountBinding?.accountId ?? null) !==
              (session.accountBinding?.accountId ?? null)
          )
            throw Error('source_changed');
        };
        assert();
        await assertRuntimeCurrent?.();
        assert();
        const parsed = learningToolSchemas.CaptureMemoryCandidate.safeParse(input);
        if (
          !parsed.success ||
          (parsed.data.action === 'capture' && !parsed.data.candidate) ||
          (parsed.data.action === 'sources' && parsed.data.candidate)
        )
          throw Error('invalid_candidate');
        const request = parsed.data;
        const result =
          request.action === 'sources'
            ? {
                policy: selected!.getSessionLearningPolicy(sessionId),
                sources: selected!.listSessionLearningSources(sessionId, request.beforeSeq),
                scope: 'unclassified',
                processingEnrollment: 'unchanged',
              }
            : selected!.captureMemoryCandidate(sessionId, request.candidate);
        assert();
        return { content: JSON.stringify(result), isError: false };
      } catch (error) {
        const code =
          error instanceof Error && knownFailures.has(error.message)
            ? error.message
            : 'capture_failed';
        log.warn('Session learning capture unavailable', {
          stage: 'candidate_capture',
          code,
          sessionId,
          causeType: error instanceof Error ? error.name : typeof error,
        });
        return {
          content: JSON.stringify({
            status: 'failed',
            code,
            message:
              'No capture was confirmed. Check learning mode and current access; retry the exact payload with the same requestId after recovery. Off requires an explicit user setting change.',
          }),
          isError: true,
        };
      }
    },
  };
}
