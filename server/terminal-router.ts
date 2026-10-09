import { Router, type RequestHandler } from 'express';
import { TerminalOpenBody, TerminalInputBody, TerminalResizeBody } from '@mitzo/protocol';
import { registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import type { TerminalService } from './terminal-service.js';

export function createTerminalRouter(options: {
  service: TerminalService;
  authorize: RequestHandler;
  observeAuth?: (session: AuthSession, invalidate: () => void) => () => void;
}) {
  const router = Router();
  router.use(options.authorize);
  router.get('/', (_req, res) =>
    res.json({ terminals: options.service.list(res.locals.authSession.id) }),
  );
  router.post('/', requireSameOriginJson, async (req, res) => {
    const body = TerminalOpenBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid terminal destination' });
      return;
    }
    try {
      res.status(201).json(await options.service.open(res.locals.authSession.id, body.data));
    } catch {
      res.status(409).json({ error: 'Terminal unavailable. Check the selected environment.' });
    }
  });
  router.get('/:id/events', async (req, res) => {
    let release: (() => void) | undefined;
    let closed = false;
    let unobserve = () => {};
    unobserve = (options.observeAuth ?? registerAuthSession)(res.locals.authSession, () => {
      closed = true;
      release?.();
      res.end();
    });
    if (closed) {
      unobserve();
      return;
    }
    res.on('close', () => {
      closed = true;
      release?.();
      unobserve();
    });
    try {
      options.service.get(res.locals.authSession.id, String(req.params.id));
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      release = await options.service.subscribe(
        res.locals.authSession.id,
        String(req.params.id),
        (event) => {
          if (closed) return;
          if (res.writableLength > 256 * 1024) {
            res.end();
            return;
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      );
      if (closed) release();
    } catch {
      if (res.headersSent) res.end();
      else res.status(404).json({ error: 'Terminal unavailable' });
    }
  });
  router.post('/:id/input', requireSameOriginJson, async (req, res) => {
    const body = TerminalInputBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid terminal input' });
      return;
    }
    try {
      await options.service.write(res.locals.authSession.id, String(req.params.id), body.data.data);
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Terminal unavailable' });
    }
  });
  router.post('/:id/resize', requireSameOriginJson, async (req, res) => {
    const body = TerminalResizeBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid terminal size' });
      return;
    }
    try {
      await options.service.resize(
        res.locals.authSession.id,
        String(req.params.id),
        body.data.cols,
        body.data.rows,
      );
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Terminal unavailable' });
    }
  });
  router.post('/:id/end', requireSameOriginJson, async (req, res) => {
    try {
      await options.service.end(res.locals.authSession.id, String(req.params.id));
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Terminal unavailable' });
    }
  });
  return router;
}
