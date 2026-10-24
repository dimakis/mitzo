import { Router, type Request, type RequestHandler } from 'express';
import { operatorAuthMiddleware, isAuthSessionCurrent, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import type { NativeResponsesStore } from './native-responses-store.js';
import {
  LegacyNativeCommitInput,
  reviewLegacyNativeContinuation,
  assertLegacyNativeReviewCurrent,
  type LegacyNativeSource,
  type LegacyNativeReview,
} from './legacy-native-continuation.js';

/** This router is an explicit context-review entrance to ordinary admission,
 * not a second native launcher. Mount at /api/sessions/:id/native-continuation. */
export function createLegacyNativeContinuationRouter(deps: {
  store(): NativeResponsesStore;
  source(id: string): LegacyNativeSource;
  hasSession(id: string): boolean;
  commandState(review: LegacyNativeReview): 'consumed' | 'uncertain' | undefined;
  admit: RequestHandler;
}) {
  const router = Router({ mergeParams: true });
  router.use(operatorAuthMiddleware);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !isAuthSessionCurrent(auth))
      return void res.status(403).json({ error: 'Current interactive operator required' });
    next();
  });
  router.get('/', (req: Request, res) => {
    const id = String(req.params.id);
    if (!deps.hasSession(id)) return void res.status(404).json({ error: 'Conversation not found' });
    try {
      res.json({
        links: deps
          .store()
          .listLegacyNativeLinks(id, (res.locals.authSession as AuthSession).id)
          .map((link) => {
            let canReviewAgain = false;
            if (link.state === 'reviewed' || link.state === 'discarded') {
              const saved = deps
                .store()
                .readLegacyNativeLink(link.reviewHash, (res.locals.authSession as AuthSession).id);
              canReviewAgain =
                deps.commandState(saved.review) === undefined &&
                !deps.hasSession(link.nativeSessionId);
            }
            return { ...link, canReviewAgain };
          }),
      });
    } catch {
      res.status(503).json({ error: 'Linked native continuation history unavailable' });
    }
  });
  router.post('/preview', requireSameOriginJson, (req: Request, res) => {
    try {
      const auth = res.locals.authSession as AuthSession;
      const review = reviewLegacyNativeContinuation(
        deps.source(String(req.params.id)),
        structuredClone(req.body),
      );
      if (deps.hasSession(review.nativeSessionId))
        throw Error('Select an unused prepared native workspace');
      deps.store().saveLegacyNativeReview(review, auth.id);
      res.json(review);
    } catch {
      res.status(409).json({
        code: 'native_continuation_unavailable',
        error:
          'Native continuation review unavailable. Close the original execution, select its account and Local Mac native workspace, and review again.',
      });
    }
  });
  router.post('/discard', requireSameOriginJson, (req: Request, res) => {
    const input = LegacyNativeCommitInput.pick({ reviewHash: true }).safeParse(req.body);
    if (!input.success) return void res.status(400).json({ error: 'Exact native review required' });
    try {
      const auth = res.locals.authSession as AuthSession;
      const store = deps.store();
      const { review } = store.readLegacyNativeLink(input.data.reviewHash, auth.id);
      if (review.sourceSessionId !== req.params.id) throw Error('Original source required');
      store.discardLegacyNativeReview(review.reviewHash, auth.id, () => {
        if (
          !isAuthSessionCurrent(auth) ||
          deps.commandState(review) !== undefined ||
          deps.hasSession(review.nativeSessionId)
        )
          throw Error('Native command outcome must remain with its original owner');
      });
      res.json({
        reviewHash: review.reviewHash,
        sourceSessionId: review.sourceSessionId,
        nativeSessionId: review.nativeSessionId,
        commandId: review.commandId,
        state: 'discarded',
      });
    } catch {
      res
        .status(409)
        .json({
          error: 'This review has a claimed or unconfirmed command. Check its original admission.',
        });
    }
  });
  router.post('/commit', requireSameOriginJson, async (req: Request, res, next) => {
    const input = LegacyNativeCommitInput.safeParse(req.body);
    if (!input.success)
      return void res.status(400).json({ error: 'Review the exact native continuation first' });
    let review: LegacyNativeReview | undefined;
    let auth: AuthSession | undefined;
    try {
      auth = { ...(res.locals.authSession as AuthSession) };
      const store = deps.store();
      const link = store.readLegacyNativeLink(input.data.reviewHash, auth.id);
      review = link.review;
      if (review.sourceSessionId !== req.params.id)
        throw Error('Original continuation source required');
      if (link.state === 'discarded') throw Error('This native review was discarded');
      if (link.state !== 'reviewed') {
        const state = deps.commandState(review) ?? 'uncertain';
        if (state === 'consumed') store.completeLegacyNativeLink(review.reviewHash, auth.id);
        // A lost commit reply observes durable acceptance. It never dispatches
        // again, including after a process restart or an uncertain admission.
        return void res.status(202).json({
          ok: state === 'consumed',
          sessionId: review.nativeSessionId,
          clientMsgId: review.commandId,
          sourceSessionId: review.sourceSessionId,
          state,
          dispatched: false,
        });
      }
      assertLegacyNativeReviewCurrent(review, deps.source(review.sourceSessionId));
      if (
        (review.uncertainOutcomes && !input.data.acknowledgeUncertainOutcomes) ||
        (review.selectionChanged && !input.data.acknowledgeSelectionChange)
      )
        throw Error('Explicitly acknowledge the displayed uncertainty and selection changes');
      if (deps.hasSession(review.nativeSessionId))
        throw Error('Selected native workspace already has a conversation');
      if (!isAuthSessionCurrent(auth)) throw Error('Operator authorization expired');
      if (!store.claimLegacyNativeLink(review.reviewHash, auth.id))
        throw Error('Native continuation was already attempted');
      // Reuse the exact reviewed command, same SSE connection and normal
      // permission/capability/workspace/account checks. Never copy checkpoints.
      req.body = structuredClone(review.command);
      await deps.admit(req, res, next);
    } catch {
      if (!res.headersSent)
        res.status(409).json({
          code: 'native_continuation_unavailable',
          error:
            'The reviewed native continuation is unavailable. Refresh its source, selection and uncertainty review before a new attempt.',
        });
    } finally {
      if (review && auth) {
        try {
          if (deps.commandState(review) === 'consumed')
            deps.store().completeLegacyNativeLink(review.reviewHash, auth.id);
        } catch {
          // The claim stays uncertain. Never hide or replay a lost outcome.
        }
      }
    }
  });
  return router;
}
