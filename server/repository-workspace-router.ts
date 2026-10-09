import express from 'express';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import type { AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';

const selection = z.strictObject({
  accountId: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
});
const previewInput = selection.extend({
  connectionId: z.string().min(1).max(128),
  repository: z.string().min(3).max(256),
});
export function createRepositoryWorkspaceRouter(deps: {
  resolveBinding(accountId: string, model: string): AccountBinding;
  catalog(binding: AccountBinding): unknown;
  preview(
    binding: AccountBinding,
    connectionId: string,
    repository: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  prepare(id: string, binding: AccountBinding, signal: AbortSignal): Promise<unknown>;
  status?(id: string, binding: AccountBinding): unknown;
  discard?(id: string, binding: AccountBinding): Promise<void>;
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    const auth = res.locals.authSession as AuthSession | undefined;
    res.set('Cache-Control', 'no-store');
    if (!auth || auth.expiresAt <= Date.now())
      return res.status(401).json({ error: 'Interactive operator authentication required' });
    next();
  });
  router.get('/catalog', (req, res) => {
    const parsed = selection.safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({ error: 'Select an AI account and model first' });
    try {
      return res.json(deps.catalog(deps.resolveBinding(parsed.data.accountId, parsed.data.model)));
    } catch {
      return res.status(409).json({ error: 'Repository account selection unavailable' });
    }
  });
  router.post('/preview', requireSameOriginJson, async (req, res) => {
    const input = previewInput.safeParse(req.body);
    if (!input.success)
      return res.status(400).json({ error: 'Select an account, connection and GitHub repository' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const auth = res.locals.authSession as AuthSession;
    const timer = setTimeout(abort, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
    try {
      const binding = deps.resolveBinding(input.data.accountId, input.data.model);
      return res.json(
        await deps.preview(
          binding,
          input.data.connectionId,
          input.data.repository,
          controller.signal,
        ),
      );
    } catch {
      return res.status(409).json({
        error:
          'Repository preview unavailable. Check the selected account, GitHub connection and repository access.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
    }
  });
  router.post('/:id/prepare', requireSameOriginJson, async (req, res) => {
    const input = selection.safeParse(req.body);
    if (!input.success || !z.uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Select a valid repository preview and account' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const auth = res.locals.authSession as AuthSession;
    const timer = setTimeout(abort, Math.min(120000, Math.max(0, auth.expiresAt - Date.now())));
    try {
      const binding = deps.resolveBinding(input.data.accountId, input.data.model);
      return res.json(await deps.prepare(String(req.params.id), binding, controller.signal));
    } catch {
      return res.status(409).json({
        error:
          'Repository preparation unavailable. Refresh the preview if its commit or connection changed. Initial support is limited to regular files, 10,000 files and 64 MiB of source.',
      });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
    }
  });
  router.get('/:id', (req, res) => {
    const input = selection.safeParse(req.query);
    if (!input.success || !z.uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Invalid repository preparation' });
    try {
      if (!deps.status) throw new Error('unavailable');
      return res.json(
        deps.status(
          String(req.params.id),
          deps.resolveBinding(input.data.accountId, input.data.model),
        ),
      );
    } catch {
      return res.status(404).json({ error: 'Repository preparation unavailable for this account' });
    }
  });
  router.delete('/:id', requireSameOriginJson, async (req, res) => {
    const input = selection.safeParse(req.query);
    if (!input.success || !z.uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Invalid repository preparation' });
    try {
      if (!deps.discard) throw new Error('unavailable');
      await deps.discard(
        String(req.params.id),
        deps.resolveBinding(input.data.accountId, input.data.model),
      );
      return res.json({ discarded: true });
    } catch {
      return res
        .status(409)
        .json({ error: 'Only an unused repository preparation can be discarded' });
    }
  });
  return router;
}
