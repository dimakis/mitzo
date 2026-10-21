import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { LifecyclePreview, OpenShellLifecycleService } from './openshell-lifecycle-service.js';

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

/** Session visibility changes only after physical release has been verified.
 * Archive is deliberately separate and never implies destructive consent. */
export function createSessionRemovalRouter(deps: {
  authorize: RequestHandler;
  lifecycle(): OpenShellLifecycleService | null;
  hasSandbox(id: string): boolean;
  previewLegacy?(id: string, signal: AbortSignal): Promise<LifecyclePreview>;
  hide(id: string): void;
  changed(id: string): void;
}) {
  const router = Router();
  const managed = (id: string) =>
    deps
      .lifecycle()
      ?.inventory()
      .find((r) => r.conversationId === id);
  const unavailable =
    'Sandbox ownership is unavailable. Archive the chat or review it in Sandboxes.';
  router.get('/:id/deletion-preview', deps.authorize, async (req, res) => {
    try {
      const id = req.params.id;
      if (typeof id !== 'string' || !id)
        return res.status(400).json({ error: 'A single conversation ID is required.' });
      const record = managed(id);
      if (record && record.state !== 'deleted')
        return res.json({
          sandbox: await deps.lifecycle()!.preview(id, AbortSignal.timeout(120_000), 'delete'),
        });
      if (!record && deps.hasSandbox(id) && deps.previewLegacy)
        return res.json({ sandbox: await deps.previewLegacy(id, AbortSignal.timeout(120_000)) });
      return res.json({
        sandbox: null,
        blockedReason: !record && deps.hasSandbox(id) ? unavailable : null,
      });
    } catch (error) {
      return res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Deletion review unavailable.' });
    }
  });
  router.delete('/:id', deps.authorize, async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !id)
      return res.status(400).json({ error: 'A single conversation ID is required.' });
    try {
      if (req.query.archive !== '1') {
        const record = managed(id);
        if ((record && record.state !== 'deleted') || (!record && deps.hasSandbox(id))) {
          const token = req.body?.cleanupToken;
          if (typeof token !== 'string' || !token)
            return res
              .status(409)
              .json({ error: 'Review sandbox deletion before removing this chat.' });
          const service = deps.lifecycle();
          if (!service) return res.status(409).json({ error: unavailable });
          const result = await service.confirm(token, AbortSignal.timeout(120_000), id);
          if (result !== 'deleted')
            return res
              .status(409)
              .json({ error: 'Sandbox release is incomplete. The chat has been retained.' });
        }
      }
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
