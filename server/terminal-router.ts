import { Router, type RequestHandler } from 'express';
import { TerminalOpenBody, TerminalInputBody, TerminalResizeBody } from '@mitzo/protocol';
import { registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { AdviserBody, type TerminalAdviser } from './terminal-adviser.js';
import type { TerminalService } from './terminal-service.js';

export function createTerminalRouter(options: {
  service: TerminalService;
  authorize: RequestHandler;
  adviser?: TerminalAdviser;
  accounts?: () => Promise<unknown>;
  context?: (sessionId?: string) => unknown;
  destinations?: () => unknown;
  observeAuth?: (session: AuthSession, invalidate: () => void) => () => void;
}) {
  const router = Router();
  router.use(options.authorize);
  router.get('/', (_req, res) =>
    res.json({ terminals: options.service.list(res.locals.authSession.id) }),
  );
  router.get('/accounts', async (_req, res) => {
    try {
      res.json((await options.accounts?.()) ?? []);
    } catch {
      res.status(503).json({ error: 'Adviser account catalog unavailable' });
    }
  });
  router.get('/destinations', (_req, res) => res.json(options.destinations?.() ?? []));
  router.get('/context', (req, res) =>
    res.json(
      options.context?.(
        typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined,
      ) ?? {},
    ),
  );
  router.post('/:id/advice', requireSameOriginJson, async (req, res) => {
    const body = AdviserBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid adviser request' });
      return;
    }
    const controller = new AbortController();
    const unobserve = (options.observeAuth ?? registerAuthSession)(res.locals.authSession, () => {
      controller.abort();
      res.end();
    });
    res.on('close', () => controller.abort());
    try {
      options.service.get(res.locals.authSession.id, String(req.params.id));
      if (!options.adviser) throw Error('Adviser unavailable');
      const result = await options.adviser.ask(
        res.locals.authSession.id,
        body.data,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      );
      if (!controller.signal.aborted) res.json(result);
    } catch {
      if (!controller.signal.aborted)
        res.status(409).json({
          error: 'Adviser unavailable. Check the selected account, model and thinking mode.',
        });
    } finally {
      unobserve();
    }
  });
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
    const controller = new AbortController();
    const auth = res.locals.authSession as AuthSession;
    const unobserve = (options.observeAuth ?? registerAuthSession)(auth, () => controller.abort());
    try {
      await options.service.write(auth.id, String(req.params.id), body.data.data, {
        signal: controller.signal,
        expiresAt: auth.expiresAt,
      });
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Terminal unavailable' });
    } finally {
      unobserve();
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
