import { Router, type Request } from 'express';
import type { ManagedSession } from '@mitzo/harness';
import type {
  AccountBinding,
  MitzoMode,
  PermissionRequest,
  RuntimeReadiness,
} from '@mitzo/protocol';
import { recentAuthorizationSession } from './connections-router.js';
import { projectRuntimeReadiness, type RuntimeReadinessInput } from './runtime-readiness.js';

/** Bounded observation, not admission or an authority token. Unknown is never an empty grant. */
export interface SessionAccessEvidence {
  sessionId: string;
  observedAt: number;
  state: 'current' | 'unknown';
  account: Pick<AccountBinding, 'accountId' | 'accountLabel' | 'provider'> | null;
  model: string | null;
  mode: MitzoMode | null;
  grants: string[] | null;
  skillCeiling: string[] | null;
  pending: Array<{ permId: string; toolName: string; scope: string }> | null;
  attachments: null;
  tools: null;
  limits: null;
  readiness: RuntimeReadiness;
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
    } catch {
      return res.status(503).json({ error: 'Session Access could not be checked' });
    }
  });
  return router;
}
