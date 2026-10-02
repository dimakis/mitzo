import {
  SemanticCheckStateReportSchema,
  type SemanticCheckStateReport,
} from './symposium-semantic-criterion-runner.js';
import type { createSymposiumReviewPublicationPreflight } from './symposium-review-publication.js';
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SymposiumReviewCoordinator,
  type SymposiumReviewHost,
  type ReviewContext,
} from './symposium-review-coordinator.js';
import {
  ReviewLimitsSchema,
  ApplicationPolicySchema,
  type SymposiumReviewStore,
} from './symposium-review-workflows.js';

/** Installed by trusted bootstrap only. Dispatch must retain the production runtime gate,
 * bind the reservation to its native attempt, and resolve only on terminal completion.
 * Recovery reads durable receipts; HTTP requests never supply provider output. */
export interface SymposiumInteractiveReviewHost extends SymposiumReviewHost {
  criterionChecks?(): Array<{
    id: string;
    criterion: string;
    kind: 'file-sha256' | 'python-json-cases';
    path: string;
  }>;
  /** Refresh host-owned physical artifact facts using the current authenticated owner. */
  refreshArtifact?(context: ReviewContext): Promise<void>;
  runCriterionCheck?(
    context: ReviewContext,
    workflowId: string,
    definitionId: string,
  ): Promise<{ evidenceId: string }>;
  getCriterionCheckState?(
    context: ReviewContext,
    workflowId: string,
    definitionId: string,
  ): Promise<SemanticCheckStateReport>;
  cleanupCriterionCheck?(
    context: ReviewContext,
    workflowId: string,
    definitionId: string,
  ): Promise<{ state: string; retryAllowed: false; semanticEvidenceAllowed: false }>;
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
  limits: ReviewLimitsSchema,
});
const artifact = {
  expectedArtifactRevision: Id,
  expectedArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
};
const StartApplicationRun = Start.extend({ limits: ApplicationPolicySchema, ...artifact });
const Action = z.discriminatedUnion('action', [
  z.strictObject({ ...artifact, action: z.literal('stop') }),
  z.strictObject({
    ...artifact,
    action: z.literal('continue'),
    limits: ApplicationPolicySchema,
    reason: Id,
  }),
  z.strictObject({ ...artifact, action: z.literal('initial') }),
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
    kind: z.enum(['initial', 'review', 'fix']),
  }),
  z.strictObject({ ...artifact, action: z.literal('evidence'), evidenceId: Id }),
  z.strictObject({ ...artifact, action: z.literal('check'), definitionId: Id }),
  z.strictObject({ ...artifact, action: z.literal('cleanup-check'), definitionId: Id }),
  z.strictObject({ ...artifact, action: z.literal('check-state'), definitionId: Id }),
  z.strictObject({ ...artifact, action: z.literal('review-record') }),
  z.strictObject({
    ...artifact,
    action: z.literal('dismiss'),
    fingerprint: Id,
    reason: Id,
    evidenceRefs: z.array(Id).min(1),
  }),
]);
export function createSymposiumReviewRouter(deps: {
  store: SymposiumReviewStore;
  getHost(sessionId: string): SymposiumInteractiveReviewHost | null;
  hasSession(sessionId: string): boolean;
  /** Trusted request authorization hook; never derives capabilities from HTTP bodies. */
  authorizeContext?(req: Request, res: Response, context: ReviewContext): ReviewContext;
  getPublicationPreflight?(
    sessionId: string,
  ): ReturnType<typeof createSymposiumReviewPublicationPreflight> | null;
}): Router {
  const router = Router({ mergeParams: true });
  const requestContexts = new WeakMap<Request, ReviewContext>();
  router.use((req, res, next) => {
    if (!(res.locals.authSession as { id?: string } | undefined)?.id) {
      res.status(403).json({ error: 'Interactive authentication required' });
      return;
    }
    if (!deps.hasSession((req.params as { id: string; workflowId: string }).id)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      const baseContext = { sessionId: (req.params as { id: string }).id, owner: 'user' };
      const authorized = deps.authorizeContext
        ? deps.authorizeContext(req, res, baseContext)
        : baseContext;
      if (authorized.owner !== baseContext.owner || authorized.sessionId !== baseContext.sessionId)
        throw new Error('Authorization scope changed');
      requestContexts.set(req, authorized);
    } catch {
      res.status(403).json({ error: 'Current interactive authorization required' });
      return;
    }
    next();
  });
  const context = (req: Request): ReviewContext => {
    const authorized = requestContexts.get(req);
    if (!authorized) throw new Error('Interactive context unavailable');
    return authorized;
  };
  router.get('/', async (req, res) => {
    const ctx = context(req);
    const host = deps.getHost(ctx.sessionId);
    let available = Boolean(host);
    let applicationRun: {
      available: boolean;
      initialArtifact: { revision: string; hash: string } | null;
      reason?: string;
    } = { available: false, initialArtifact: null, reason: 'Trusted initial artifact unavailable' };
    try {
      await host?.refreshArtifact?.(ctx);
      if (host?.initialArtifact) {
        const initial = z
          .strictObject({ revision: Id, hash: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(host.initialArtifact(ctx));
        const current = host.currentArtifact(ctx);
        if (initial.revision === current.revision && initial.hash === current.hash)
          applicationRun = { available: true, initialArtifact: initial };
        else applicationRun.reason = 'Initial artifact has changed';
      }
    } catch {
      available = false;
      applicationRun = {
        available: false,
        initialArtifact: null,
        reason: 'Host artifact verification unavailable',
      };
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      available,
      stopAvailable: Boolean(host),
      cleanupAvailable: Boolean(host?.cleanupCriterionCheck),
      applicationRun,
      workflows: deps.store.list(ctx.owner, ctx.sessionId),
      criterionChecks: host?.criterionChecks?.() ?? [],
    });
  });
  router.post('/', async (req, res) => {
    const input = Start.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid review request' });
      return;
    }
    const ctx = context(req);
    try {
      const host = deps.getHost(ctx.sessionId);
      await host?.refreshArtifact?.(ctx);
      const result = new SymposiumReviewCoordinator(deps.store, host).start(ctx, input.data);
      res.status('kind' in result ? 409 : 200).json(result);
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Review unavailable' });
    }
  });
  router.post('/application-runs', async (req, res) => {
    const input = StartApplicationRun.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid application run request' });
      return;
    }
    const ctx = context(req);
    try {
      const host = deps.getHost(ctx.sessionId);
      await host?.refreshArtifact?.(ctx);
      const result = new SymposiumReviewCoordinator(deps.store, host).startApplicationRun(
        ctx,
        input.data,
      );
      res.status('kind' in result ? 409 : 200).json(result);
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Application run unavailable' });
    }
  });
  router.get('/records/:recordId', (req, res) => {
    const ctx = context(req);
    res.set('Cache-Control', 'no-store');
    try {
      const record = deps.store.getReviewRecord(ctx.owner, ctx.sessionId, req.params.recordId);
      if (!record) {
        res.status(404).json({ error: 'Review record not found' });
        return;
      }
      res.json(record);
    } catch {
      res.status(409).json({ error: 'Review record integrity check failed' });
    }
  });
  router.post('/records/:recordId/publication-preflight', async (req, res) => {
    const ctx = context(req);
    res.set('Cache-Control', 'no-store');
    try {
      if (!deps.store.getReviewRecord(ctx.owner, ctx.sessionId, req.params.recordId)) {
        res.status(404).json({ error: 'Review record not found' });
        return;
      }
      const host = deps.getHost(ctx.sessionId);
      await host?.refreshArtifact?.(ctx);
      const preflight = host && deps.getPublicationPreflight?.(ctx.sessionId);
      if (!preflight) {
        res.status(409).json({
          kind: 'decision_required',
          code: 'review_publication_unavailable',
          publication: 'not_created',
        });
        return;
      }
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once('close', abort);
      try {
        res.json(await preflight.inspect(ctx, req.params.recordId, req.body, controller.signal));
      } finally {
        res.off('close', abort);
      }
    } catch {
      res.status(409).json({
        kind: 'decision_required',
        code: 'review_publication_preflight_failed',
        publication: 'not_created',
      });
    }
  });
  router.get('/:workflowId', (req, res) => {
    const ctx = context(req);
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
    const ctx = context(req);
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
      // Stop fences known work even when physical verification is unavailable.
      if (
        action.action !== 'stop' &&
        action.action !== 'cleanup-check' &&
        action.action !== 'check-state'
      )
        await host.refreshArtifact?.(ctx);
      let result: unknown;
      if (action.action === 'stop') result = await coordinator.stop(ctx, workflowId);
      else if (action.action === 'check-state') {
        if (!host.getCriterionCheckState) throw new Error('Original check state unavailable');
        result = {
          ...SemanticCheckStateReportSchema.parse(
            await host.getCriterionCheckState(ctx, workflowId, action.definitionId),
          ),
          workflowId,
          resultId: inspected.currentResultId,
          artifactRevision: inspected.artifactRevision,
          artifactHash: inspected.artifactHash,
          definitionId: action.definitionId,
        };
        const after = coordinator.status(ctx, workflowId);
        if (
          after.currentResultId !== inspected.currentResultId ||
          after.artifactRevision !== inspected.artifactRevision ||
          after.artifactHash !== inspected.artifactHash
        )
          throw new Error('Check-state workflow artifact changed');
        res.set('Cache-Control', 'no-store');
      } else if (action.action === 'cleanup-check') {
        if (!host.cleanupCriterionCheck) throw new Error('Original check cleanup unavailable');
        result = await host.cleanupCriterionCheck(ctx, workflowId, action.definitionId);
        const after = coordinator.status(ctx, workflowId);
        if (
          after.currentResultId !== inspected.currentResultId ||
          after.artifactRevision !== inspected.artifactRevision ||
          after.artifactHash !== inspected.artifactHash
        )
          throw new Error('Cleanup workflow artifact changed');
      } else if (action.action === 'continue')
        result = coordinator.continue(ctx, workflowId, action.limits, action.reason);
      else if (action.action === 'review-record') {
        const finalized = coordinator.exportRecord(ctx, workflowId);
        if (finalized.kind !== 'verified') {
          res.status(409).json(finalized);
          return;
        }
        // Export only. Publication is a separate explicit action; findings are untrusted data.
        result = {
          ...finalized,
          publication: 'not_created',
        };
      } else if (action.action === 'dismiss')
        result = coordinator.dismissFinding(ctx, {
          workflowId,
          fingerprint: action.fingerprint,
          reason: action.reason,
          evidenceRefs: action.evidenceRefs,
        });
      else if (action.action === 'evidence')
        result = coordinator.recordHostEvidence(ctx, workflowId, action.evidenceId);
      else if (action.action === 'check') {
        if (!host.runCriterionCheck) {
          res.status(409).json({ kind: 'decision_required', code: 'trusted_check_unavailable' });
          return;
        }
        const evidence = await host.runCriterionCheck(ctx, workflowId, action.definitionId);
        result = coordinator.recordHostEvidence(ctx, workflowId, evidence.evidenceId);
      } else {
        let attemptId: string;
        const kind = action.action === 'recover' ? action.kind : action.action;
        if (action.action === 'recover') {
          attemptId = action.attemptId;
          const preparation = deps.store.getApplicationPreparation(workflowId, attemptId);
          if (preparation?.status === 'preparing' || preparation?.status === 'bound') {
            const expectedKind =
              kind === 'review' &&
              (inspected.status === 'awaiting_delta_review' ||
                inspected.policyResumeStatus === 'awaiting_delta_review')
                ? 'delta'
                : kind;
            if (inspected.limits.mode !== 'application' || preparation.kind !== expectedKind) {
              res.status(409).json({ kind: 'decision_required', code: 'preparation_changed' });
              return;
            }
            if (inspected.decisionCode) {
              const settled = await coordinator.reconcileStoppedPreparations(ctx, workflowId);
              const latest = deps.store.getApplicationPreparation(workflowId, attemptId);
              if (latest?.status !== 'settled' && !latest?.resumeReady) {
                res.status(409).json({ kind: 'decision_required', code: 'preparation_uncertain' });
                return;
              }
              res.json(settled);
              return;
            }
            // Resume the exact charged transition. The physical owners reuse only
            // retained verified receipts; an uncertain copy remains quarantined.
            const reservation =
              preparation.status === 'bound'
                ? coordinator.recoverBoundTransition(ctx, workflowId, kind, attemptId)
                : await coordinator.reserveWithTransition(ctx, workflowId, kind, attemptId);
            if (
              reservation.kind === 'decision_required' &&
              reservation.code === 'attempt_already_dispatched'
            ) {
              // Native admission was already consumed. Reconcile the original receipt below.
            } else if (reservation.kind !== 'reserved_not_dispatched') {
              res.status(409).json(reservation);
              return;
            } else {
              await host.dispatch(ctx, reservation);
              await host.refreshArtifact?.(ctx);
            }
          }
        } else {
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
          const reservation =
            (kind === 'initial' || kind === 'review' || kind === 'fix') &&
            inspected.limits.mode === 'application'
              ? await coordinator.reserveWithTransition(ctx, workflowId, kind, attemptId)
              : coordinator.reserve(ctx, workflowId, kind, attemptId);
          if (reservation.kind !== 'reserved_not_dispatched') {
            res.status(409).json(reservation);
            return;
          }
          await host.dispatch(ctx, reservation);
          await host.refreshArtifact?.(ctx);
        }
        if (kind === 'initial')
          result = coordinator.recordInitialResult(ctx, workflowId, attemptId);
        else if (kind === 'fix') result = coordinator.recordFix(ctx, workflowId, attemptId);
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
      res.status(409).json({
        error:
          input.data.action === 'check-state'
            ? 'Original quarantined check state unavailable'
            : error instanceof Error
              ? error.message
              : 'Review action failed',
      });
    }
  });
  return router;
}
