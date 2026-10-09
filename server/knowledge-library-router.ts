import express from 'express';
import { z } from 'zod';
import { registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import {
  AcceptedKnowledgeSource,
  safeKnowledgeDirectory,
  safeKnowledgePath,
} from './knowledge-library-source.js';
import {
  KnowledgeDraftConflict,
  KnowledgeDraftMissing,
  KnowledgeDraftStore,
  type KnowledgeDraft,
} from './knowledge-draft-store.js';
import type { KnowledgeReviewService } from './knowledge-review-service.js';
import type { KnowledgeGithubPublisher } from './knowledge-github-publisher.js';

export interface KnowledgeLibraryDependencies {
  source: AcceptedKnowledgeSource;
  store: KnowledgeDraftStore;
  syncedAt: string | null;
  acceptanceEnabled: boolean;
  refresh(): Promise<void>;
  reviewService?: KnowledgeReviewService;
  publisher?: KnowledgeGithubPublisher;
}
const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
const document = z.strictObject({
  path: z.string().refine(safeKnowledgePath),
  sourcePath: z.string().refine(safeKnowledgePath).optional(),
  content: z.string().refine((s) => Buffer.byteLength(s) <= 5 * 1024 * 1024),
});
const documents = z.array(document).max(20);
const directories = z.array(z.string().refine(safeKnowledgeDirectory)).max(20).optional();
const create = z.strictObject({
  requestId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  baseRevision: revision,
  documents,
  directories,
});
const save = z.strictObject({
  version: z.number().int().positive(),
  documents,
  baseRevision: revision.optional(),
  directories,
});
class AuthorityExpired extends Error {}
/** Browser-only, no task/session argument or client-selected credentials, paths or refs. */
export function createKnowledgeLibraryRouter(
  load: () => Promise<KnowledgeLibraryDependencies | undefined>,
) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || auth.expiresAt <= Date.now())
      return res.status(401).json({ error: 'Interactive operator authentication required' });
    next();
  });
  router.use((req, res, next) =>
    req.method === 'GET' ? next() : requireSameOriginJson(req, res, next),
  );
  type Context = { runtime: KnowledgeLibraryDependencies; assert(): void; signal: AbortSignal };
  function route(
    work: (req: express.Request, res: express.Response, context: Context) => Promise<unknown>,
  ): express.RequestHandler {
    return async (req, res) => {
      const auth = res.locals.authSession as AuthSession;
      const controller = new AbortController();
      const unregister = registerAuthSession(auth, () => controller.abort());
      const assert = () => {
        if (controller.signal.aborted || auth.expiresAt <= Date.now()) throw new AuthorityExpired();
      };
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(120_000, Math.max(0, auth.expiresAt - Date.now())),
      );
      const abort = () => controller.abort();
      req.once('aborted', abort);
      try {
        assert();
        const runtime = await load();
        assert();
        if (!runtime)
          return res.status(503).json({
            error:
              'Knowledge Library is not configured. Select its accepted source in host configuration.',
          });
        return await work(req, res, { runtime, assert, signal: controller.signal });
      } catch (error) {
        if (error instanceof AuthorityExpired || controller.signal.aborted)
          return res.status(403).json({ error: 'Operator authorization expired or revoked' });
        if (error instanceof KnowledgeDraftMissing)
          return res.status(404).json({ error: error.message });
        if (error instanceof KnowledgeDraftConflict)
          return res.status(409).json({ error: error.message });
        return res.status(422).json({
          error: 'Knowledge operation could not be completed. Saved drafts are retained.',
        });
      } finally {
        clearTimeout(timer);
        unregister();
        req.off('aborted', abort);
      }
    };
  }
  async function catalog(context: Context) {
    const catalog = await context.runtime.source.catalog(context.signal);
    context.assert();
    return {
      ...catalog,
      drafts: context.runtime.store.listSummaries(),
      syncedAt: context.runtime.syncedAt,
      reviewEnabled: Boolean(context.runtime.reviewService),
      acceptanceEnabled: context.runtime.acceptanceEnabled,
    };
  }
  function id(req: express.Request) {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new KnowledgeDraftConflict('Invalid draft identity');
    return parsed.data;
  }
  async function submit(context: Context, draft: KnowledgeDraft) {
    if (!context.runtime.reviewService)
      return { draft, reviewError: 'Draft saved. Review publishing is not configured.' };
    try {
      await context.runtime.refresh();
      context.assert();
      const reviewed = await context.runtime.reviewService.submit(
        draft.id,
        draft.version,
        context.signal,
      );
      context.assert();
      return { draft: reviewed };
    } catch (error) {
      context.assert();
      return {
        draft: context.runtime.store.get(draft.id),
        reviewError:
          error instanceof KnowledgeDraftConflict
            ? error.message
            : 'Draft saved. Its review could not be confirmed. Retry Save to recover the same change.',
      };
    }
  }
  router.get(
    '/',
    route(async (_req, res, context) => res.json(await catalog(context))),
  );
  router.post(
    '/refresh',
    route(async (_req, res, context) => {
      await context.runtime.refresh();
      context.assert();
      return res.json(await catalog(context));
    }),
  );
  router.get(
    '/document',
    route(async (req, res, context) => {
      const input = z
        .strictObject({ path: z.string().refine(safeKnowledgePath), revision })
        .safeParse(req.query);
      if (!input.success) return res.status(400).json({ error: 'Invalid document request' });
      const result = await context.runtime.source.read(
        input.data.path,
        input.data.revision,
        context.signal,
      );
      context.assert();
      return res.json(result);
    }),
  );
  router.post(
    '/drafts',
    route(async (req, res, context) => {
      const input = create.safeParse(req.body);
      if (
        !input.success ||
        input.data.documents.some((d) => !context.runtime.source.allowed(d.path))
      )
        return res.status(400).json({ error: 'Invalid knowledge draft' });
      await context.runtime.source.validateStructure(
        input.data.baseRevision,
        input.data.documents,
        input.data.directories,
        context.signal,
      );
      const docs = await Promise.all(
        input.data.documents.map(async (d) => ({
          ...d,
          base: (
            await context.runtime.source.read(
              d.sourcePath ?? d.path,
              input.data.baseRevision,
              context.signal,
            )
          ).content,
        })),
      );
      context.assert();
      return res.status(201).json({
        draft: context.runtime.store.create(
          input.data.title,
          input.data.baseRevision,
          docs,
          input.data.requestId,
          input.data.directories,
        ),
      });
    }),
  );
  router.get(
    '/drafts/:id',
    route(async (req, res, context) => res.json({ draft: context.runtime.store.get(id(req)) })),
  );
  router.put(
    '/drafts/:id',
    route(async (req, res, context) => {
      const draftId = id(req);
      const input = save.safeParse(req.body);
      if (
        !input.success ||
        input.data.documents.some((d) => !context.runtime.source.allowed(d.path))
      )
        return res.status(400).json({ error: 'Invalid knowledge draft' });
      context.runtime.reviewService?.assertIdle(draftId);
      const draft = context.runtime.store.get(draftId);
      if (draft.version !== input.data.version)
        throw new KnowledgeDraftConflict('Draft changed in another window. Reload before saving.');
      const baseRevision = input.data.baseRevision ?? draft.baseRevision;
      if (input.data.baseRevision && baseRevision !== (await context.runtime.source.revision()))
        throw new KnowledgeDraftConflict(
          'Accepted knowledge changed again. Refresh before resolving.',
        );
      await context.runtime.source.validateStructure(
        baseRevision,
        input.data.documents,
        input.data.directories ?? draft.directories,
        context.signal,
      );
      const docs = await Promise.all(
        input.data.documents.map(async (d) => ({
          ...d,
          base: (
            await context.runtime.source.read(d.sourcePath ?? d.path, baseRevision, context.signal)
          ).content,
        })),
      );
      context.assert();
      const saved = context.runtime.store.save(
        draftId,
        input.data.version,
        docs,
        baseRevision,
        input.data.directories,
      );
      return res.json(await submit(context, saved));
    }),
  );
  router.post(
    '/drafts/:id/review',
    route(async (req, res, context) => {
      const input = z.strictObject({ version: z.number().int().positive() }).safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Invalid review request' });
      const draft = context.runtime.store.get(id(req));
      if (draft.version !== input.data.version)
        throw new KnowledgeDraftConflict('Draft changed in another window. Reload before saving.');
      return res.json(await submit(context, draft));
    }),
  );
  function reviewIdentity(context: Context, draft: KnowledgeDraft) {
    if (!draft.review || !context.runtime.publisher || !context.runtime.reviewService)
      throw new KnowledgeDraftConflict('This draft has no confirmed review');
    return {
      draftId: draft.id,
      url: draft.review.url,
      head: draft.review.head,
      repository: context.runtime.reviewService.config.repository,
      baseBranch: context.runtime.reviewService.config.baseBranch,
      signal: context.signal,
    };
  }
  router.post(
    '/drafts/:id/reconcile',
    route(async (req, res, context) => {
      const draft = context.runtime.store.get(id(req));
      context.runtime.store.assertIdle(draft.id);
      if (!draft.review || !context.runtime.publisher) return res.json({ draft });
      const inspected = await context.runtime.publisher.inspect(reviewIdentity(context, draft));
      context.assert();
      const current = context.runtime.store.get(draft.id);
      context.runtime.store.assertIdle(draft.id);
      if (current.version !== draft.version)
        throw new KnowledgeDraftConflict(
          'Draft changed while checking its review. Refresh before continuing.',
        );
      if (inspected.state !== 'in-review' && current.review?.version !== current.version) {
        const updated = context.runtime.store.status(
          draft.id,
          'draft',
          'Previous review finished. Start a new change with your remaining edits.',
        );
        return res.json({ draft: updated, canAccept: false, reason: updated.error });
      }
      const state =
        inspected.state === 'in-review' && current.version !== current.review?.version
          ? 'draft'
          : inspected.state;
      const updated =
        inspected.state === 'in-review' &&
        current.review?.version === current.version &&
        typeof inspected.draft === 'boolean'
          ? context.runtime.store.receipt(draft.id, current.version, {
              ...current.review,
              ready: !inspected.draft,
            })
          : context.runtime.store.status(draft.id, state, current.error);
      return res.json({
        draft: updated,
        canAccept: inspected.canAccept && current.version === current.review?.version,
        reason: inspected.reason,
        currentHead: inspected.head,
      });
    }),
  );
  router.post(
    '/drafts/:id/ready',
    route(async (req, res, context) => {
      const input = z
        .strictObject({ version: z.number().int().positive(), head: revision })
        .safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Invalid review submission' });
      if (!context.runtime.publisher)
        throw new KnowledgeDraftConflict('Review publishing is not configured');
      const draft = context.runtime.store.get(id(req));
      if (
        draft.state !== 'in-review' ||
        draft.version !== input.data.version ||
        draft.review?.version !== draft.version ||
        draft.review.head !== input.data.head
      )
        throw new KnowledgeDraftConflict('Save the current draft before sending it for review');
      const lease = context.runtime.store.acquire(draft.id);
      try {
        const sent = await context.runtime.publisher.sendForReview(reviewIdentity(context, draft));
        context.assert();
        if (sent.head !== draft.review.head || sent.draft !== false || sent.state !== 'in-review')
          throw new KnowledgeDraftConflict('Review submission could not be confirmed');
        const updated = context.runtime.store.receipt(
          draft.id,
          draft.version,
          { ...draft.review, ready: true },
          lease,
        );
        return res.json({ draft: updated, canAccept: false });
      } finally {
        context.runtime.store.release(draft.id, lease);
      }
    }),
  );
  router.post(
    '/drafts/:id/cancel',
    route(async (req, res, context) => {
      const input = z.strictObject({ version: z.number().int().positive() }).safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Invalid cancellation request' });
      const draft = context.runtime.store.get(id(req));
      context.runtime.store.assertIdle(draft.id);
      context.runtime.reviewService?.assertIdle(draft.id);
      if (draft.version !== input.data.version)
        throw new KnowledgeDraftConflict(
          'Draft changed in another window. Reload before cancelling.',
        );
      if (draft.state === 'accepted')
        throw new KnowledgeDraftConflict('This change was accepted and cannot be cancelled.');
      if (draft.state === 'closed') return res.json({ draft });
      if (
        draft.publication &&
        (!draft.review ||
          draft.publication.version !== draft.version ||
          draft.publication.head !== draft.review.head)
      )
        throw new KnowledgeDraftConflict('Recover the saved review before cancelling this change.');
      if (draft.review && draft.review.version !== draft.version)
        throw new KnowledgeDraftConflict(
          'Recover the current saved review before cancelling this change.',
        );
      const lease = context.runtime.store.acquire(draft.id);
      try {
        if (draft.review) {
          const identity = reviewIdentity(context, draft);
          const closed = await context.runtime.publisher!.cancel({
            ...identity,
            beforeClose: () => {
              context.assert();
              context.runtime.store.assertLease(draft.id, lease);
              const current = context.runtime.store.get(draft.id);
              if (
                current.version !== draft.version ||
                current.review?.head !== draft.review?.head ||
                current.review?.version !== draft.version ||
                current.state === 'accepted' ||
                current.state === 'closed'
              )
                throw new KnowledgeDraftConflict(
                  'Draft changed while cancelling its review. The saved copy is retained.',
                );
            },
          });
          context.assert();
          if (closed.state !== 'closed' || closed.head !== draft.review.head)
            throw new KnowledgeDraftConflict(
              'Review closure could not be confirmed. The saved copy is retained.',
            );
        }
        context.assert();
        return res.json({
          draft: context.runtime.store.status(draft.id, 'closed', undefined, lease, draft.version),
        });
      } finally {
        context.runtime.store.release(draft.id, lease);
      }
    }),
  );
  router.post(
    '/drafts/:id/accept',
    route(async (req, res, context) => {
      const input = z
        .strictObject({ version: z.number().int().positive(), head: revision })
        .safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'Invalid acceptance request' });
      if (!context.runtime.acceptanceEnabled || !context.runtime.publisher)
        throw new KnowledgeDraftConflict('Acceptance is not enabled for this library');
      const draft = context.runtime.store.get(id(req));
      context.runtime.reviewService?.assertIdle(draft.id);
      if (
        draft.state !== 'in-review' ||
        draft.version !== input.data.version ||
        draft.review?.version !== draft.version ||
        draft.review.head !== input.data.head ||
        draft.review.ready !== true
      )
        throw new KnowledgeDraftConflict(
          'Save the current draft, send it for review and refresh its review before accepting',
        );
      const lease = context.runtime.store.acquire(draft.id);
      try {
        if (context.runtime.store.get(draft.id).version !== draft.version)
          throw new KnowledgeDraftConflict('Draft changed before acceptance');
        await context.runtime.publisher.accept(reviewIdentity(context, draft));
        context.assert();
        const accepted = context.runtime.store.status(
          draft.id,
          'accepted',
          undefined,
          lease,
          draft.version,
        );
        try {
          await context.runtime.refresh();
        } catch {
          /* Acceptance is durable. A later refresh reconciles the accepted catalog. */
        }
        context.assert();
        return res.json({ draft: accepted });
      } finally {
        context.runtime.store.release(draft.id, lease);
      }
    }),
  );
  return router;
}
