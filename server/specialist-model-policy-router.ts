import { Router } from 'express';
import { z } from 'zod';
import { SpecialistModelPolicySaveSchema } from '@mitzo/protocol';
import { recentAuthorizationSession, requireSameOriginJson } from './connections-router.js';
import { isAuthSessionCurrent } from './auth.js';
import { getSpecialistConsultations } from './specialist-consultation-runtime.js';
import { loadAccountProfiles } from './account-profiles.js';
import type { EventStore } from './event-store.js';
import { createLogger } from './logger.js';

const log = createLogger('specialist-model-policy');
const inputSchema = SpecialistModelPolicySaveSchema.extend({
  scope: z.enum(['workspace', 'conversation']),
});
export function createSpecialistModelPolicyRouter(events: EventStore) {
  const router = Router();
  router.use('/:sessionId', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    if (!isAuthSessionCurrent(auth))
      return res.status(403).json({ error: 'Operator authorization expired or revoked' });
    const session = events.getSession(req.params.sessionId);
    if (
      !session ||
      session.isHidden ||
      session.sessionType === 'symposium' ||
      session.symposiumConfig ||
      req.params.sessionId === 'workspace'
    )
      return res.status(404).json({ error: 'Ordinary conversation unavailable' });
    next();
  });
  const failure = (error: unknown, res: import('express').Response) => {
    if (error instanceof Error && /Model policy (revision|request) conflict/.test(error.message))
      return res.status(409).json({ error: error.message + '. Refresh before editing again.' });
    log.error('Model policy operation failed', {
      err: error,
      stage: 'model_policy',
      sessionId: res.req.params.sessionId,
    });
    return res
      .status(503)
      .json({ error: 'Model policy could not be confirmed. Retry the original save or refresh.' });
  };
  router.get('/:sessionId', (req, res) => {
    try {
      return res.json({
        ...getSpecialistConsultations().receipts.modelPolicies.view(req.params.sessionId),
        accounts: loadAccountProfiles()
          .catalog()
          .map(({ id, label, models }) => ({
            id,
            label,
            models: models.map(({ id, label }) => ({ id, label })),
          })),
      });
    } catch (error) {
      return failure(error, res);
    }
  });
  router.put('/:sessionId', requireSameOriginJson, (req, res) => {
    const input = inputSchema.safeParse(req.body);
    if (!input.success)
      return res
        .status(400)
        .json({
          error:
            'Invalid model policy. Use one rule per account/model and positive allowances or unlimited.',
        });
    const { scope, ...save } = input.data;
    try {
      return res.json(
        getSpecialistConsultations().receipts.modelPolicies.save(
          scope === 'workspace' ? 'workspace' : req.params.sessionId,
          save,
        ),
      );
    } catch (error) {
      return failure(error, res);
    }
  });
  return router;
}
