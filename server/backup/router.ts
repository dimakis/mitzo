import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { BackupService } from './service.js';
export function createBackupRouter(
  service: Pick<BackupService, 'overview' | 'start' | 'refresh'>,
  operatorAuth: RequestHandler,
) {
  const router = Router();
  router.use(operatorAuth);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!res.locals.authSession?.id) {
      res.sendStatus(403);
      return;
    }
    next();
  });
  router.get('/', async (_req, res) => {
    try {
      res.json(await service.overview());
    } catch {
      res.status(503).json({ error: 'Backup status unavailable' });
    }
  });
  for (const [path, action] of [
    ['/run', () => service.start()],
    ['/refresh', () => service.refresh()],
  ] as const) {
    router.post(path, async (req, res) => {
      if (!req.is('application/json') || !z.object({}).strict().safeParse(req.body).success) {
        res.status(400).json({ error: 'Expected an empty JSON object' });
        return;
      }
      try {
        await action();
        res.status(202).json({ accepted: true });
      } catch {
        res.status(409).json({ error: 'Backup unavailable or busy. Check setup and status.' });
      }
    });
  }
  return router;
}
