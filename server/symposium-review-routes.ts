import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SymposiumReviewCoordinator,
  type SymposiumReviewHost,
  type ReviewContext,
} from './symposium-review-coordinator.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';

/** Installed by trusted bootstrap only. Dispatch must retain the production runtime gate,
 * bind the reservation to its native attempt, and resolve only on terminal completion.
 * Recovery reads durable receipts; HTTP requests never supply provider output. */
export interface SymposiumInteractiveReviewHost extends SymposiumReviewHost {
  dispatch(
    context: ReviewContext,
    reservation: Extract<
      ReturnType<SymposiumReviewCoordinator['reserve']>,
      { kind: 'reserved_not_dispatched' }
    >,
  ): Promise<void>;
}
const Id = z.string().trim().min(1).max(500);
const Start = z.strictObject({
  workflowId: Id,
  acceptanceCriteria: z.array(Id).min(1).max(100),
  limits: z.strictObject({
    maxReviewRounds: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxCostUsd: z.number().finite().nonnegative().nullable(),
  }),
});
const artifact = {
  expectedArtifactRevision: Id,
  expectedArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
};
const Action = z.discriminatedUnion('action', [
  z.strictObject({ ...artifact, action: z.literal('review') }),
  z.strictObject({
    ...artifact,
    action: z.literal('fix'),
    findingFingerprints: z.array(Id).min(1),
    reason: Id,
  }),
  z.strictObject({
    ...artifact,
    action: z.literal('recover'),
    attemptId: Id,
    kind: z.enum(['review', 'fix']),
  }),
  z.strictObject({ ...artifact, action: z.literal('evidence'), evidenceId: Id }),
  z.strictObject({ ...artifact, action: z.literal('review-record') }),
]);
export function createSymposiumReviewRouter(deps: {
  store: SymposiumReviewStore;
  getHost(sessionId: string): SymposiumInteractiveReviewHost | null;
  hasSession(sessionId: string): boolean;
}): Router {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    if (!(res.locals.authSession as { id?: string } | undefined)?.id) {
      res.status(403).json({ error: 'Interactive authentication required' });
      return;
    }
    if (!deps.hasSession(req.params.id)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    next();
  });
  const context = (sessionId: string, actor: string): ReviewContext => ({
    sessionId,
    owner: `operator:${actor}`,
  });
  router.get('/', (req, res) => {
    const ctx = context(req.params.id, res.locals.authSession.id);
    res.json({
      available: Boolean(deps.getHost(ctx.sessionId)),
      workflows: deps.store.list(ctx.owner, ctx.sessionId),
    });
  });
  router.post('/', (req, res) => {
    const input = Start.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid review request' });
      return;
    }
    const ctx = context(req.params.id, res.locals.authSession.id);
    try {
      const result = new SymposiumReviewCoordinator(deps.store, deps.getHost(ctx.sessionId)).start(
        ctx,
        input.data,
      );
      res.status('kind' in result ? 409 : 200).json(result);
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Review unavailable' });
    }
  });
  router.get('/:workflowId', (req, res) => {
    const ctx = context(req.params.id, res.locals.authSession.id);
    try {
      const workflow = new SymposiumReviewCoordinator(
        deps.store,
        deps.getHost(ctx.sessionId),
      ).status(ctx, req.params.workflowId);
      res.json({ workflow, history: deps.store.history(workflow.workflowId) });
    } catch {
      res.status(404).json({ error: 'Review workflow not found' });
    }
  });
  router.post('/:workflowId/actions', async (req, res) => {
    const input = Action.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid review action' });
      return;
    }
    const ctx = context(req.params.id, res.locals.authSession.id);
    const host = deps.getHost(ctx.sessionId);
    const coordinator = new SymposiumReviewCoordinator(deps.store, host);
    const workflowId = req.params.workflowId;
    try {
      const inspected = coordinator.status(ctx, workflowId);
      if (
        inspected.artifactRevision !== input.data.expectedArtifactRevision ||
        inspected.artifactHash !== input.data.expectedArtifactHash
      ) {
        res.status(409).json({ kind: 'decision_required', code: 'artifact_changed' });
        return;
      }
      if (!host) {
        res
          .status(409)
          .json({ kind: 'decision_required', code: 'trusted_review_host_unavailable' });
        return;
      }
      const action = input.data;
      let result: unknown;
      if (action.action === 'review-record') {
        const finalized = coordinator.finalize(ctx, workflowId);
        if (finalized.kind !== 'verified') {
          res.status(409).json(finalized);
          return;
        }
        // Export only. Publication is a separate explicit action; findings are untrusted data.
        result = {
          ...finalized,
          workflow: coordinator.status(ctx, workflowId),
          history: deps.store.history(workflowId),
          publication: 'not_created',
        };
      } else if (action.action === 'evidence')
        result = coordinator.recordHostEvidence(ctx, workflowId, action.evidenceId);
      else {
        let attemptId: string;
        const kind = action.action === 'recover' ? action.kind : action.action;
        if (action.action === 'recover') attemptId = action.attemptId;
        else {
          if (action.action === 'fix') {
            const authorized = coordinator.authorizeFix(ctx, {
              workflowId,
              findingFingerprints: action.findingFingerprints,
              reason: action.reason,
            });
            if ('kind' in authorized) {
              res.status(409).json(authorized);
              return;
            }
          }
          attemptId = randomUUID();
          const reservation = coordinator.reserve(ctx, workflowId, kind, attemptId);
          if (reservation.kind !== 'reserved_not_dispatched') {
            res.status(409).json(reservation);
            return;
          }
          await host.dispatch(ctx, reservation);
        }
        if (kind === 'fix') result = coordinator.recordFix(ctx, workflowId, attemptId);
        else {
          const review = host.completedReview(ctx, attemptId);
          if (!review) {
            res
              .status(409)
              .json({ kind: 'decision_required', code: 'host_review_result_required', attemptId });
            return;
          }
          result = coordinator.recordReview(ctx, {
            workflowId,
            attemptId,
            reviewId: review.reviewId,
          });
        }
      }
      res
        .status(
          result &&
            typeof result === 'object' &&
            'kind' in result &&
            result.kind === 'decision_required'
            ? 409
            : 200,
        )
        .json(result);
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Review action failed' });
    }
  });
  return router;
}
