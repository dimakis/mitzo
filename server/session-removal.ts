import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import type { LifecyclePreview, OpenShellLifecycleService } from './openshell-lifecycle-service.js';
import type { SessionResourceRemovalService } from './session-resource-removal.js';
import { requireSameOriginJson } from './connections-router.js';

export interface LocalRemovalPreview {
  action: 'retire' | 'retain';
  reason: string;
}
export type RemovalAuthority = (() => void) & { signal?: AbortSignal };

/** Positive remote evidence or unresolved legacy Codex routing requires ownership
 * review. Working directories alone cannot establish execution location. */
export function sessionNeedsSandboxReview(
  meta:
    | {
        cwd?: string | null;
        sessionType?: string;
        symposiumConfig?: string | null;
        accountBinding?: { provider: string } | null;
      }
    | undefined
    | null,
  evidence: {
    runtimeLocation?: 'local' | 'openshell';
    legacyOpenShellConfigured?: boolean;
  },
): boolean {
  if (
    meta?.sessionType === 'symposium' ||
    meta?.symposiumConfig ||
    meta?.cwd?.startsWith('/sandbox/')
  )
    return true;
  if (evidence.runtimeLocation) return evidence.runtimeLocation === 'openshell';
  // Legacy OpenAI conversations predate retained location bindings. Their cwd
  // can be arbitrary, and today's server configuration cannot prove past routing.
  return (
    meta?.accountBinding?.provider === 'openai' ||
    meta?.accountBinding?.provider === 'openai-codex' ||
    (!meta?.accountBinding && evidence.legacyOpenShellConfigured === true)
  );
}

/** Session visibility changes only after the reviewed disposition is verified.
 * Archive is deliberately separate and never implies destructive consent. */
export function createSessionRemovalRouter(deps: {
  authorize: RequestHandler;
  lifecycle(): OpenShellLifecycleService | null;
  hasSandbox(id: string): boolean;
  previewLegacy?(id: string, signal: AbortSignal): Promise<LifecyclePreview>;
  hide(id: string): void;
  changed(id: string): void;
  removal?: {
    service: SessionResourceRemovalService;
    authority(req: Request, res: Response): RemovalAuthority;
    localPreview(id: string): LocalRemovalPreview;
    releaseLocal(id: string, assertCurrent: () => void): Promise<void>;
  };
}) {
  const router = Router();
  const managed = (id: string) =>
    deps
      .lifecycle()
      ?.inventory()
      .find((r) => r.conversationId === id);
  const unavailable =
    'Sandbox ownership is unavailable. Archive the chat or review it in Sandboxes.';
  const review = async (id: string) => {
    const removal = deps.removal?.service.read(id);
    let sandbox: LifecyclePreview | null = null;
    let localWorkspace: LocalRemovalPreview | null = null;
    let blockedReason: string | null;
    try {
      const record = managed(id);
      sandbox =
        record && record.state !== 'deleted'
          ? await deps.lifecycle()!.preview(id, AbortSignal.timeout(120_000), 'delete')
          : !record && deps.hasSandbox(id) && deps.previewLegacy
            ? await deps.previewLegacy(id, AbortSignal.timeout(120_000))
            : null;
      blockedReason = !record && deps.hasSandbox(id) && !deps.previewLegacy ? unavailable : null;
      if (deps.removal && !deps.hasSandbox(id)) localWorkspace = deps.removal.localPreview(id);
    } catch (error) {
      if (!deps.removal) throw error;
      blockedReason = error instanceof Error ? error.message : 'Resource ownership is unavailable.';
    }
    return {
      sandbox,
      blockedReason,
      ...(deps.removal
        ? {
            removal: removal
              ? {
                  operationId: removal.operationId,
                  phase: removal.phase,
                  canKeep: !removal.releaseStarted,
                }
              : null,
            needsPreparation: !deps.removal.service.isPrepared(id),
            localWorkspace,
          }
        : {}),
    };
  };
  router.get('/:id/deletion-preview', deps.authorize, async (req, res) => {
    try {
      const id = req.params.id;
      if (typeof id !== 'string' || !id)
        return res.status(400).json({ error: 'A single conversation ID is required.' });
      return res.json(await review(id));
    } catch (error) {
      return res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Deletion review unavailable.' });
    }
  });
  router.post('/:id/prepare-deletion', deps.authorize, requireSameOriginJson, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !id) return res.sendStatus(400);
    if (!deps.removal) return res.sendStatus(409);
    try {
      const current = deps.removal.authority(req, res);
      await deps.removal.service.prepare(id, current);
      const preview = await review(id);
      current();
      return res.json(preview);
    } catch (error) {
      return res.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : 'Shutdown could not be verified. The chat has been retained.',
      });
    }
  });
  router.post('/:id/keep-chat', deps.authorize, requireSameOriginJson, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !id || typeof req.body?.removalOperationId !== 'string')
      return res.sendStatus(400);
    if (!deps.removal) return res.sendStatus(409);
    try {
      deps.removal.service.keep(id, req.body.removalOperationId, deps.removal.authority(req, res));
      return res.json({ ok: true });
    } catch (error) {
      return res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Review the original removal.' });
    }
  });
  const jsonMutation: RequestHandler = (req, res, next) =>
    deps.removal ? requireSameOriginJson(req, res, next) : next();
  router.delete('/:id', deps.authorize, jsonMutation, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !id)
      return res.status(400).json({ error: 'A single conversation ID is required.' });
    try {
      if (req.query.archive === '1') {
        const removal = deps.removal?.service.read(id);
        if (removal?.releaseStarted && removal.phase !== 'completed')
          throw Error('Resource release has started. Review its outcome before archiving.');
      }
      if (req.query.archive !== '1') {
        const release = async () => {
          const record = managed(id);
          if ((record && record.state !== 'deleted') || (!record && deps.hasSandbox(id))) {
            const token = req.body?.cleanupToken;
            if (typeof token !== 'string' || !token)
              throw Error('Review sandbox deletion before removing this chat.');
            const service = deps.lifecycle();
            if (!service) throw Error(unavailable);
            const current = deps.removal?.authority(req, res);
            current?.();
            const timeout = AbortSignal.timeout(120_000);
            const result = await service.confirm(
              token,
              current?.signal ? AbortSignal.any([timeout, current.signal]) : timeout,
              id,
            );
            if (result !== 'deleted')
              throw Error('Sandbox release is incomplete. The chat has been retained.');
          }
          if (deps.removal && !deps.hasSandbox(id))
            await deps.removal.releaseLocal(id, deps.removal.authority(req, res));
        };
        if (deps.removal) {
          if (typeof req.body?.removalOperationId !== 'string')
            throw Error('Stop and review this chat before deleting.');
          await deps.removal.service.release(
            id,
            req.body.removalOperationId,
            deps.removal.authority(req, res),
            release,
          );
        } else await release();
      }
      deps.removal?.authority(req, res)();
      deps.hide(id);
      deps.changed(id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : 'Sandbox release could not be verified. The chat has been retained.',
      });
    }
  });
  return router;
}
