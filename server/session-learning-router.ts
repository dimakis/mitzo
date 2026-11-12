import { Router } from 'express';
import { z } from 'zod';
import { SessionLearningModeSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { recentAuthorizationSession } from './connections-router.js';
import { createLogger } from './logger.js';
const log = createLogger('session-learning-settings');
const update = z.strictObject({
  mode: SessionLearningModeSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
});
export function createSessionLearningRouter(events: EventStore) {
  const router = Router({ mergeParams: true });
  const state = (id: string) => ({
    policy: events.getSessionLearningPolicy(id),
    integration: {
      deepWorker: 'not_implemented',
      downstreamOffEnforcement: 'pending_mgmt',
      guidanceChanges: 'next_adapter_admission',
      captureChanges: 'immediate',
    },
  });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!recentAuthorizationSession(res)) return;
    const session = typeof req.params.id === 'string' && events.getSession(req.params.id);
    if (
      !session ||
      session.isHidden ||
      session.sessionType === 'symposium' ||
      session.symposiumConfig
    )
      return res.status(404).json({ error: 'Conversation not found' });
    if (req.method !== 'GET' && req.get('X-Mitzo-Learning-Intent') !== 'set-mode')
      return res.status(403).json({ error: 'Use explicit session learning settings' });
    next();
  });
  router.get('/', (req, res) => res.json(state(req.params.id as string)));
  router.patch('/', (req, res) => {
    const input = update.safeParse(req.body);
    if (!input.success)
      return res
        .status(400)
        .json({ error: 'Select auto, deep or off with the current policy revision' });
    try {
      events.setSessionLearningMode(
        req.params.id as string,
        input.data.mode,
        input.data.expectedRevision,
      );
      return res.json(state(req.params.id as string));
    } catch (error) {
      const conflict = error instanceof Error && error.message === 'learning_revision_conflict';
      log.warn('Session learning setting failed', {
        stage: 'policy_save',
        code: conflict ? 'revision_conflict' : 'policy_save_failed',
        sessionId: req.params.id,
      });
      return res
        .status(conflict ? 409 : 503)
        .json({
          error: conflict
            ? 'Learning settings changed; refresh and retry with the current revision'
            : 'Learning setting was not confirmed; refresh before retrying',
        });
    }
  });
  return router;
}
