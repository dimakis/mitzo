import { Router } from 'express';
import { ZodError } from 'zod';
import type { BriefingSnapshot, PhilosophyQuote } from '@mitzo/protocol';
import { HomeConflict, HomeStore, homeUpdateSchema, validDate } from './home-store.js';

/** Mounted behind the app's existing /api authentication boundary. */
export function createHomeRouter(deps: {
  store: HomeStore;
  catalog: () => PhilosophyQuote[];
  briefing: (date: string) => BriefingSnapshot | null;
}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/preferences', (_req, res) => {
    try {
      res.json(deps.store.preferences());
    } catch {
      res
        .status(503)
        .json({ error: 'Home preferences are unavailable. Retry before making changes.' });
    }
  });
  router.put('/preferences', (req, res) => {
    try {
      const { revision, ...patch } = homeUpdateSchema.parse(req.body);
      res.json(deps.store.update(revision, patch));
    } catch (error) {
      res
        .status(error instanceof HomeConflict ? 409 : error instanceof ZodError ? 400 : 503)
        .json({
          error:
            error instanceof HomeConflict
              ? error.message
              : error instanceof ZodError
                ? 'Invalid home preference update.'
                : 'Could not save home preferences.',
        });
    }
  });
  router.get(['/quote', '/briefing'], (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    if (!validDate(date)) {
      res.status(400).json({ error: 'date must be a calendar date in YYYY-MM-DD format' });
      return;
    }
    try {
      if (req.path === '/quote') res.json(deps.store.dailyQuote(date, deps.catalog()));
      else {
        const report = deps.briefing(date);
        if (report) res.json(report);
        else res.status(404).json({ error: 'No saved morning briefing for this date.' });
      }
    } catch {
      res.status(503).json({ error: 'Saved content is unavailable. Retry.' });
    }
  });
  return router;
}
