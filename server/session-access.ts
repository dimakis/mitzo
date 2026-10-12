import { Router, type Request } from 'express';
import { effectivePermissionMode, type ManagedSession } from '@mitzo/harness';
import type { AccountBinding, MitzoMode, PermissionRequest } from '@mitzo/protocol';
import { recentAuthorizationSession } from './connections-router.js';
import type { CodexAccessObservation } from './codex-conversation.js';

/** Bounded observation, not admission or an authority token. Unknown is never an empty grant. */
export interface SessionAccessEvidence {
  sessionId: string;
  observedAt: number;
  state: 'current' | 'unknown';
  account: Pick<AccountBinding, 'accountId' | 'accountLabel' | 'provider'> | null;
  model: string | null;
  modelSource: 'live-session' | CodexAccessObservation['modelSource'] | null;
  runtime: { harness: 'claude-sdk' | 'codex'; location: 'local' | 'openshell' } | null;
  mode: MitzoMode | null;
  grants: string[] | null;
  skillCeiling: string[] | null;
  pending: Array<{ permId: string; toolName: string; scope: string }> | null;
  attachments: null;
  tools: null;
  limits: null;
}
export function projectSessionAccess(
  sessionId: string,
  session: ManagedSession | undefined,
  pending: PermissionRequest[],
  now = Date.now(),
  codex?: CodexAccessObservation,
): SessionAccessEvidence {
  const value: SessionAccessEvidence = {
    sessionId,
    observedAt: now,
    state: 'unknown',
    account: null,
    model: null,
    modelSource: null,
    runtime: null,
    mode: null,
    grants: null,
    skillCeiling: null,
    pending: null,
    attachments: null,
    tools: null,
    limits: null,
  };
  if (!session || session.sessionId !== sessionId || !session.accountBinding) return value;
  const sdk = session.accountBinding.provider === 'anthropic-vertex';
  if (
    !sdk &&
    (!['openai-codex', 'openai'].includes(session.accountBinding.provider) ||
      session.contributorExecutionOwner ||
      !codex ||
      codex.sessionId !== sessionId ||
      codex.account.accountId !== session.accountBinding.accountId ||
      codex.account.provider !== session.accountBinding.provider ||
      codex.account.profileRevision !== session.accountBinding.profileRevision)
  )
    return value;
  const { accountId, accountLabel, provider } = session.accountBinding;
  return {
    ...value,
    state: 'current',
    account: { accountId, accountLabel, provider },
    model: sdk ? (session.model ?? session.accountBinding.model) : codex!.model,
    modelSource: sdk ? 'live-session' : codex!.modelSource,
    runtime: sdk
      ? { harness: 'claude-sdk', location: 'local' }
      : { harness: 'codex', location: codex!.location },
    mode: effectivePermissionMode(session),
    grants: [...session.sessionAllowList].sort(),
    skillCeiling: session.activeSkillPolicy ? [...session.activeSkillPolicy].sort() : null,
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
