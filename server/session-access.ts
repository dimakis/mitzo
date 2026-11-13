import { Router, type Request } from 'express';
import type { ManagedSession } from '@mitzo/harness';
import type {
  PermissionRequest,
  RuntimeReadiness,
  SessionAccessEvidence,
  SessionHelperSupport,
} from '@mitzo/protocol';
import { recentAuthorizationSession } from './connections-router.js';
import { projectRuntimeReadiness, type RuntimeReadinessInput } from './runtime-readiness.js';
import { projectAgentHelperSupport } from './agent-tool-selection.js';
import { createLogger } from './logger.js';
import { sessionMetadataDiagnostic } from './session-metadata-error.js';

const log = createLogger('session-access');
export type { SessionAccessEvidence, SessionHelperSupport } from '@mitzo/protocol';

function helperSupport(
  session: ManagedSession | undefined,
  readiness: RuntimeReadiness,
): SessionHelperSupport {
  if (
    !session?.ordinaryRuntimeOwner ||
    readiness.session.state !== 'observed' ||
    readiness.execution.state !== 'configured'
  )
    return { state: 'unknown', reason: 'runtime_unavailable' };
  const binding = readiness.execution.binding;
  if (
    binding.version !== 2 ||
    binding.execution.location !== 'local' ||
    !['codex', 'claude-sdk'].includes(binding.harness.implementation)
  )
    return { state: 'unknown', reason: 'route_unqualified' };
  const route = binding.harness.implementation === 'codex' ? 'codex-owned-local' : 'claude-sdk';
  const tools = projectAgentHelperSupport(session, route, session.activeSkillPolicy);
  return tools
    ? { state: 'configured', tools }
    : { state: 'unknown', reason: 'selection_unavailable' };
}

export function projectSessionAccess(
  sessionId: string,
  session: ManagedSession | undefined,
  pending: PermissionRequest[],
  now = Date.now(),
  runtime: Omit<RuntimeReadinessInput, 'sessionId' | 'session'> = {},
): SessionAccessEvidence {
  const readiness = projectRuntimeReadiness({ ...runtime, sessionId, session }, now);
  const value: SessionAccessEvidence = {
    sessionId,
    observedAt: now,
    state: 'unknown',
    account: null,
    model: null,
    mode: null,
    grants: null,
    skillCeiling: null,
    pending: null,
    attachments: null,
    tools: null,
    limits: null,
    readiness,
    helperSupport: helperSupport(session, readiness),
  };
  if (!session || readiness.session.state !== 'observed') return value;
  const { accountId, accountLabel, provider } = readiness.session.account;
  return {
    ...value,
    state: 'current',
    account: { accountId, accountLabel, provider },
    model: readiness.session.model,
    mode: readiness.session.mode,
    grants: readiness.session.grants,
    skillCeiling: readiness.session.skillCeiling,
    pending: pending
      .filter((p) => p.sessionId === sessionId)
      .map((p) => ({
        permId: p.permId,
        toolName: p.toolName,
        scope: p.approvalScope ?? 'unknown',
      })),
  };
}
/** Mount behind existing operator auth. No provider probing, credentials or mutation. */
export function createSessionAccessRouter(options: {
  hasSession(id: string): boolean;
  read(id: string): SessionAccessEvidence;
}) {
  const router = Router({ mergeParams: true });
  router.get('/', (req: Request, res) => {
    res.set('Cache-Control', 'no-store');
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    try {
      const id = req.params.id;
      if (typeof id !== 'string' || !options.hasSession(id))
        return res.status(404).json({ error: 'Conversation not found' });
      return res.json(options.read(id));
    } catch (error: unknown) {
      const diagnostic = {
        code: 'session_access_read_failed',
        stage: 'read',
        sessionId: req.params.id,
        cause:
          error instanceof TypeError
            ? 'TypeError'
            : error instanceof Error
              ? 'Error'
              : 'UnknownError',
        ...sessionMetadataDiagnostic(error),
      };
      log.warn('Session Access could not be checked', diagnostic);
      return res.status(503).json({
        error: 'Session Access could not be checked. Refresh to try again.',
        code: diagnostic.code,
        stage: diagnostic.stage,
        sessionId: diagnostic.sessionId,
      });
    }
  });
  return router;
}
