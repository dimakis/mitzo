import { Router } from 'express';
import { ZodError } from 'zod';
import type {
  BriefingSnapshot,
  PhilosophyQuote,
  SessionMeta,
  AccountBinding,
} from '@mitzo/protocol';
import {
  HomeConflict,
  HomeStore,
  homeUpdateSchema,
  briefingChatSchema,
  validDate,
} from './home-store.js';

/** Mounted behind the app's existing /api authentication boundary. */
export function createHomeRouter(deps: {
  store: HomeStore;
  catalog: () => PhilosophyQuote[];
  briefing: (
    date: string,
    signal?: AbortSignal,
  ) => BriefingSnapshot | null | Promise<BriefingSnapshot | null>;
  changed?: () => void;
  session?: (id: string) =>
    | (Pick<SessionMeta, 'sessionType' | 'selectedModel' | 'isHidden'> & {
        accountBinding?: Pick<AccountBinding, 'accountId' | 'model'> | null;
      })
    | null;
}) {
  const router = Router();
  const visibleSession = (id: string) => {
    const session = deps.session?.(id);
    return session && !session.isHidden ? session : null;
  };
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
      try {
        deps.changed?.();
      } catch {
        // The saved revision is authoritative even when a notification cannot be delivered.
      }
    } catch (error) {
      res.status(error instanceof HomeConflict ? 409 : error instanceof ZodError ? 400 : 503).json({
        error:
          error instanceof HomeConflict
            ? error.message
            : error instanceof ZodError
              ? 'Invalid home preference update.'
              : 'Could not save home preferences.',
      });
    }
  });
  router.get('/briefing-chats', (req, res) => {
    if (req.query.sessionId !== undefined) {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      if (!/^[\w.:-]{1,200}$/.test(sessionId)) {
        res.status(400).json({ error: 'Invalid session identity.' });
        return;
      }
      try {
        res.json(visibleSession(sessionId) ? deps.store.briefingChatForSession(sessionId) : []);
      } catch {
        res.status(503).json({ error: 'Briefing conversation is unavailable. Retry.' });
      }
      return;
    }
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const revision = typeof req.query.revision === 'string' ? req.query.revision : '';
    if (!validDate(date) || !/^[a-f0-9]{64}$/.test(revision)) {
      res.status(400).json({ error: 'Invalid report identity.' });
      return;
    }
    try {
      res.json(
        deps.store
          .briefingChats(date, revision)
          .filter((chat) => Boolean(visibleSession(chat.sessionId))),
      );
    } catch {
      res.status(503).json({ error: 'Briefing conversations are unavailable. Retry.' });
    }
  });
  router.post('/briefing-chats', (req, res) => {
    try {
      const binding = briefingChatSchema.parse(req.body);
      const session = visibleSession(binding.sessionId);
      if (!session || session.sessionType === 'symposium') {
        res.status(404).json({ error: 'Registered chat not found.' });
        return;
      }
      if (
        !session.accountBinding ||
        session.accountBinding.accountId !== binding.accountId ||
        (session.selectedModel || session.accountBinding.model) !== binding.model
      ) {
        res
          .status(409)
          .json({ error: 'Session account and model must match the briefing selection.' });
        return;
      }
      res.status(201).json(deps.store.registerBriefingChat(binding));
    } catch (error) {
      res.status(error instanceof ZodError ? 400 : 503).json({
        error:
          error instanceof ZodError
            ? 'Invalid briefing conversation.'
            : 'Could not save briefing conversation. Retry.',
      });
    }
  });
  router.get(['/quote', '/briefing'], async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    if (!validDate(date)) {
      res.status(400).json({ error: 'date must be a calendar date in YYYY-MM-DD format' });
      return;
    }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    try {
      if (req.path === '/quote') res.json(deps.store.dailyQuote(date, deps.catalog()));
      else {
        const report = await deps.briefing(date, controller.signal);
        if (res.destroyed) return;
        if (report) res.json(report);
        else res.status(404).json({ error: 'No saved morning briefing for this date.' });
      }
    } catch {
      if (!res.destroyed) res.status(503).json({ error: 'Saved content is unavailable. Retry.' });
    } finally {
      res.removeListener('close', cancel);
    }
  });
  return router;
}
