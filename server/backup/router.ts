import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { BackupService } from './service.js';
import { BackupSetupError, BackupSetupInput, type BackupSetup } from './setup.js';
export function createBackupRouter(
  service: Pick<BackupService, 'overview' | 'start' | 'refresh'>,
  operatorAuth: RequestHandler,
  setup?: Pick<BackupSetup, 'status' | 'prepare' | 'configure'>,
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
  if (setup) {
    router.get('/setup', async (_req, res) => {
      try {
        res.json(await setup.status());
      } catch {
        res.status(503).json({ error: 'Backup setup unavailable. Refresh to retry.' });
      }
    });
    for (const path of ['/setup/prepare', '/setup'] as const) {
      router.post(path, async (req, res) => {
        const parsed = (path === '/setup' ? BackupSetupInput : z.object({}).strict()).safeParse(
          req.body,
        );
        // Clear the request-held copy promptly; no request/error logging gets the password.
        req.body = undefined;
        if (!req.is('application/json') || !parsed.success) {
          res.status(400).json({
            error:
              'Enter a password of at least 16 characters and confirm recovery. No storage paths are accepted.',
          });
          return;
        }
        try {
          if (path === '/setup') {
            if (
              !req.secure &&
              !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
            ) {
              res
                .status(400)
                .json({ error: 'Open Mitzo over HTTPS before entering a backup password.' });
              return;
            }
            await setup.configure(BackupSetupInput.parse(parsed.data));
          } else await setup.prepare();
          res.json(await setup.status());
        } catch (error) {
          res.status(409).json({
            error:
              error instanceof BackupSetupError
                ? error.message
                : 'Backup setup did not complete. Check the Mac and retry.',
          });
        }
      });
    }
  }
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
