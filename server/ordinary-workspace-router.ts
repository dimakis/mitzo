import { Router } from 'express';
import {
  OrdinaryWorkspacePreparationRequestSchema,
  OrdinaryWorkspacePreparationReceiptSchema,
} from '@mitzo/protocol';
import {
  operatorAuthMiddleware,
  isAuthSessionCurrent,
  hasPersistentRevocationAuthority,
  registerAuthSession,
  type AuthSession,
} from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { loadAccountProfiles } from './account-profiles.js';
import { getOrdinaryWorkspaces } from './repository-workspace-runtime.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

/** Silent preparation only; no session/task/command, source or provider port. */
export function createOrdinaryWorkspacePreparationRouter(
  deps: { workspaces?(): RepositoryWorkspaces } = {},
) {
  const router = Router();
  router.post(
    '/api/ordinary/workspaces/prepare',
    operatorAuthMiddleware,
    requireSameOriginJson,
    async (req, res) => {
      const parsed = OrdinaryWorkspacePreparationRequestSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({
          code: 'invalid_request',
          error: 'Choose an account, model and execution target for the ordinary workspace.',
        });
      const input = structuredClone(parsed.data);
      if (
        input.runOn !== 'local' ||
        input.runtime.harness !== 'codex' ||
        input.runtime.account.provider !== 'openai-codex'
      )
        return res.status(409).json({
          code: 'unsupported_workspace',
          error:
            'Ordinary workspaces currently support Local Mac Codex. Choose a supported local account and target.',
        });
      if (
        custodianControllerMode ||
        custodianOwnerMode ||
        process.env.MITZO_ORDINARY_LOCAL_CODEX_ENABLED !== '1'
      )
        return res.status(503).json({
          code: 'workspace_unavailable',
          error: 'Ordinary local workspace preparation is not enabled on this server.',
        });
      const auth = { ...(res.locals.authSession as AuthSession) },
        controller = new AbortController();
      let unregister: (() => void) | undefined;
      const abort = () => controller.abort();
      const close = () => {
        if (!res.writableEnded) abort();
      };
      try {
        if (!hasPersistentRevocationAuthority() || !isAuthSessionCurrent(auth))
          throw Error('Operator authority unavailable');
        unregister = registerAuthSession(auth, abort);
        req.once('aborted', abort);
        res.once('close', close);
        const binding = loadAccountProfiles().resolve(input.runtime.account.accountId, input.model);
        controller.signal.throwIfAborted();
        const receipt = await (
          deps.workspaces?.() ?? getOrdinaryWorkspaces()
        ).prepareOrdinaryWorkspace({
          binding,
          selection: { runOn: input.runOn, runtime: input.runtime },
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (!isAuthSessionCurrent(auth)) throw Error('Operator authority unavailable');
        return res.status(201).json(OrdinaryWorkspacePreparationReceiptSchema.parse(receipt));
      } catch {
        return res.status(409).json({
          code: 'workspace_unavailable',
          error:
            'The selected ordinary workspace account or runtime is unavailable. Confirm the account and model, then prepare again.',
        });
      } finally {
        req.off('aborted', abort);
        res.off('close', close);
        unregister?.();
      }
    },
  );
  return router;
}
