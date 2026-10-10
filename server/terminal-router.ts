import { Router, type RequestHandler } from 'express';
import {
  TerminalOpenBody,
  TerminalInputBody,
  TerminalResizeBody,
  TerminalScrollBody,
} from '@mitzo/protocol';
import { registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { AdviserBody, type TerminalAdviser } from './terminal-adviser.js';
import type { TerminalService } from './terminal-service.js';
import { z } from 'zod';
import {
  getTerminalPlanAdviserHost,
  type TerminalPlanAdviserHost,
} from './terminal-plan-adviser.js';

export function createTerminalRouter(options: {
  service: TerminalService;
  authorize: RequestHandler;
  adviser?: TerminalAdviser;
  accounts?: () => Promise<unknown>;
  context?: (sessionId?: string) => unknown;
  destinations?: () => unknown;
  observeAuth?: (session: AuthSession, invalidate: () => void) => () => void;
  planAdvisers?: () => TerminalPlanAdviserHost | null;
}) {
  const router = Router();
  router.use(options.authorize);
  router.use((_req, res, next) => {
    try {
      options.service.bindOwner(res.locals.authSession, options.observeAuth ?? registerAuthSession);
      next();
    } catch {
      res.status(403).json({ error: 'Operator session unavailable' });
    }
  });
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
  const planHost = options.planAdvisers ?? getTerminalPlanAdviserHost;
  router.get('/subscriptions', (_req, res) => {
    try {
      const host = planHost();
      res.json({ enabled: !!host, accounts: host?.list() ?? [] });
    } catch {
      res.status(503).json({ error: 'Adviser accounts unavailable' });
    }
  });
  router.post('/subscriptions/start', requireSameOriginJson, async (req, res) => {
    const body = z
      .object({
        label: z.string().trim().min(1).max(80),
        accountId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid adviser sign-in request' });
      return;
    }
    const host = planHost();
    if (!host) {
      res.status(503).json({ error: 'ChatGPT adviser sign-in is not enabled on this Mac' });
      return;
    }
    try {
      const auth = res.locals.authSession as AuthSession;
      res
        .status(202)
        .json(await host.start(auth.id, auth.expiresAt, body.data.label, body.data.accountId));
    } catch {
      res.status(409).json({ error: 'Could not start adviser sign-in on the Mac. Retry.' });
    }
  });
  router.get('/subscriptions/attempts/:attempt', (req, res) => {
    try {
      const host = planHost();
      if (!host) throw Error('Unavailable');
      res.json(host.status(res.locals.authSession.id, String(req.params.attempt)));
    } catch {
      res.status(404).json({ error: 'Adviser sign-in unavailable' });
    }
  });
  router.post(
    '/subscriptions/attempts/:attempt/cancel',
    requireSameOriginJson,
    async (req, res) => {
      if (!z.object({}).strict().safeParse(req.body).success) {
        res.status(400).json({ error: 'Invalid cancellation' });
        return;
      }
      try {
        const host = planHost();
        if (!host) throw Error('Unavailable');
        await host.cancel(res.locals.authSession.id, String(req.params.attempt));
        res.json({ ok: true });
      } catch {
        res.status(409).json({ error: 'Adviser sign-in cancellation unavailable' });
      }
    },
  );
  router.post('/subscriptions/:account/disconnect', requireSameOriginJson, async (req, res) => {
    if (!z.object({}).strict().safeParse(req.body).success) {
      res.status(400).json({ error: 'Invalid disconnect request' });
      return;
    }
    const controller = new AbortController();
    const unobserve = (options.observeAuth ?? registerAuthSession)(res.locals.authSession, () =>
      controller.abort(),
    );
    try {
      const host = planHost();
      if (!host) throw Error('Unavailable');
      res.json(
        await host.disconnect(
          String(req.params.account),
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        ),
      );
    } catch {
      res
        .status(409)
        .json({ error: 'Adviser disconnect could not be confirmed. Refresh accounts.' });
    } finally {
      unobserve();
    }
  });
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
  router.post('/:id/scroll', requireSameOriginJson, async (req, res) => {
    const body = TerminalScrollBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid terminal scroll' });
      return;
    }
    const controller = new AbortController();
    const auth = res.locals.authSession as AuthSession;
    const unobserve = (options.observeAuth ?? registerAuthSession)(auth, () => controller.abort());
    res.on('close', () => controller.abort());
    try {
      await options.service.scroll(auth.id, String(req.params.id), body.data.lines, {
        signal: controller.signal,
        expiresAt: auth.expiresAt,
      });
      if (!controller.signal.aborted) res.json({ ok: true });
    } catch {
      if (!controller.signal.aborted)
        res.status(409).json({ error: 'Terminal history unavailable' });
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
