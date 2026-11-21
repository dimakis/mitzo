import { Router } from 'express';
import { z } from 'zod';
import { SpecialistModelPolicySaveSchema, SpecialistAllowanceEditSchema } from '@mitzo/protocol';
import type { SpecialistPolicy } from './specialist-consultation-contract.js';
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
const allowanceSummary = (policy: SpecialistPolicy) => ({
  policyId: policy.policyId,
  revision: policy.allowanceRevision ?? 0,
  maxConsultations: policy.maxConsultations,
  roles: [...new Set(policy.routes.map((route) => route.role))],
  expiresAt: policy.expiresAt,
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
    if (
      error instanceof Error &&
      /(?:Model policy|Consultation allowance) (revision|request) conflict/.test(error.message)
    )
      return res.status(409).json({ error: error.message + '. Refresh before editing again.' });
    if (
      error instanceof Error &&
      /Consultation policy expired or revoked|Original consultation authorization/.test(
        error.message,
      )
    )
      return res
        .status(403)
        .json({
          error:
            'The original consultation authorization is no longer current. Review a new policy.',
        });
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
        allowances: getSpecialistConsultations()
          .receipts.policies(req.params.sessionId)
          .filter(
            (policy) =>
              !policy.revoked &&
              policy.expiresAt > Date.now() &&
              policy.authSessionId === recentAuthorizationSession(res)!.id,
          )
          .map(allowanceSummary),
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
      return res.status(400).json({
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
  router.put('/:sessionId/allowances/:policyId', requireSameOriginJson, (req, res) => {
    const input = SpecialistAllowanceEditSchema.safeParse(req.body);
    if (!input.success || !z.uuid().safeParse(req.params.policyId).success)
      return res.status(400).json({ error: 'Use a positive consultation allowance or unlimited.' });
    try {
      return res.json(
        allowanceSummary(
          getSpecialistConsultations().receipts.editAllowance(
            req.params.sessionId,
            recentAuthorizationSession(res)!.id,
            req.params.policyId,
            input.data,
          ),
        ),
      );
    } catch (error) {
      return failure(error, res);
    }
  });
  return router;
}
