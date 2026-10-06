import { Router, type Request } from 'express';
import { z } from 'zod';
import type { SymposiumAccessRequests } from './symposium-access-tools.js';
import { requireSameOriginJson } from './connections-router.js';
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export function createSymposiumAccessRouter(
  service: Pick<SymposiumAccessRequests, 'list' | 'decide' | 'dismiss'>,
  hasSession: (id: string) => boolean,
) {
  const router = Router({ mergeParams: true });
  router.use((req: Request, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.authSession || res.locals.authSession.expiresAt <= Date.now())
      return res.status(403).json({ error: 'Interactive operator authentication required' });
    if (!hasSession(String(req.params.id)))
      return res.status(404).json({ error: 'Symposium session not found' });
    next();
  });
  router.get('/', (req: Request, res) => {
    res.json(service.list(String(req.params.id)));
  });
  router.use(requireSameOriginJson);
  router.post('/:requestId/decision', (req: Request, res) => {
    const input = z.strictObject({ hash: Hash, approved: z.boolean() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid access decision' });
    try {
      service.decide(
        String(req.params.id),
        String(req.params.requestId),
        input.data.hash,
        input.data.approved,
      );
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Access request changed or executing seat unavailable' });
    }
  });
  router.post('/:requestId/dismiss', (req: Request, res) => {
    const input = z.strictObject({ hash: Hash }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid request dismissal' });
    try {
      service.dismiss(String(req.params.id), String(req.params.requestId), input.data.hash);
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Publication request changed' });
    }
  });
  return router;
}
