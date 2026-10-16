import { Router, type RequestHandler, type Response } from 'express';
import {
  TelosSourcePreviewRequestSchema,
  TelosSourceAdoptRequestSchema,
  TelosWorkIdSchema,
  TelosSourceNewPreviewRequestSchema,
  TelosSourceCreateRequestSchema,
  type TelosOutcomeCreation,
} from '@mitzo/protocol';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { TelosWorkStore, TelosWorkError, type TelosWorkActor } from './telos-work-store.js';
import { TelosSourceCapture } from './telos-source-capture.js';
import { requireSameOriginJson } from './connections-router.js';
import type { EventStore } from './event-store.js';

/** Host-authenticated source selection/adoption only. No HTTP source bytes,
 * caller actors, model settings, allocator receipts or internal-token fallback.
 */
export function createTelosSourceRouter(options: {
  dbPath(): string;
  events: EventStore;
  operatorAuth: RequestHandler;
  ordinaryConversation(id: string): boolean;
  createOutcome?(input: TelosOutcomeCreation): Promise<{ itemId: string }>;
}) {
  const router = Router();
  router.use('/api/telos/work', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  const authority = (res: Response): TelosWorkActor | undefined => {
    const id: unknown = res.locals.authSession?.id;
    if (typeof id !== 'string' || !id.trim()) {
      res
        .status(403)
        .json({ code: 'unauthorized', error: 'Interactive operator authority required' });
      return;
    }
    return { kind: 'operator', id };
  };
  const run = async (
    res: Response,
    actor: TelosWorkActor,
    action: (capture: TelosSourceCapture) => unknown,
  ) => {
    let work: TelosWorkStore | undefined, artifacts: TelosArtifactStore | undefined;
    try {
      const path = options.dbPath();
      work = new TelosWorkStore(path, { ordinaryConversation: options.ordinaryConversation });
      artifacts = new TelosArtifactStore(path);
      const capture = new TelosSourceCapture({
        events: options.events,
        work,
        artifacts,
        authorizeSource: (who, id) =>
          who.kind === 'operator' && who.id === actor.id && !!options.events.getSession(id),
        authorizeArtifact: (who, itemId) =>
          who.kind === 'operator' && who.id === actor.id && artifacts!.userUploadAllowed(itemId),
      });
      res.json(await action(capture));
    } catch (error) {
      const known = error instanceof TelosWorkError;
      res
        .status(
          known
            ? { not_found: 404, unauthorized: 403, conflict: 409, invalid: 400 }[error.code]
            : 503,
        )
        .json({
          code: known ? error.code : 'unavailable',
          error: known ? error.message : 'Reviewed source service unavailable',
        });
    } finally {
      artifacts?.close();
      work?.close();
    }
  };
  for (const operation of ['preview', 'adopt'] as const) {
    router.post(
      '/api/telos/work/source/' + operation,
      options.operatorAuth,
      requireSameOriginJson,
      async (req, res) => {
        const actor = authority(res);
        if (!actor) return;
        const schema =
          operation === 'preview' ? TelosSourcePreviewRequestSchema : TelosSourceAdoptRequestSchema;
        const input = schema.safeParse(req.body);
        if (!input.success) {
          res.status(400).json({ code: 'invalid', error: 'Invalid source selection' });
          return;
        }
        await run(res, actor, (capture) =>
          operation === 'preview'
            ? capture.preview(input.data, actor)
            : capture.adopt(input.data, actor),
        );
      },
    );
  }
  for (const operation of ['preview', 'create'] as const) {
    router.post(
      '/api/telos/work/source/outcome/' + operation,
      options.operatorAuth,
      requireSameOriginJson,
      async (req, res) => {
        const actor = authority(res);
        if (!actor) return;
        const schema =
          operation === 'preview'
            ? TelosSourceNewPreviewRequestSchema
            : TelosSourceCreateRequestSchema;
        const input = schema.safeParse(req.body);
        if (!input.success) {
          res.status(400).json({ code: 'invalid', error: 'Invalid reviewed outcome' });
          return;
        }
        await run(res, actor, (capture) => {
          if (operation === 'preview') return capture.previewNew(input.data, actor);
          if (!options.createOutcome) throw Error('Canonical creator unavailable');
          return capture.createReviewed(input.data, actor, options.createOutcome);
        });
      },
    );
  }
  router.get(
    '/api/telos/work/items/:itemId/sources/:snapshotId',
    options.operatorAuth,
    async (req, res) => {
      const actor = authority(res);
      if (!actor) return;
      const item = TelosWorkIdSchema.safeParse(req.params.itemId),
        snapshot = TelosWorkIdSchema.safeParse(req.params.snapshotId);
      if (!item.success || !snapshot.success) {
        res.status(400).json({ code: 'invalid', error: 'Invalid source reference' });
        return;
      }
      await run(res, actor, (capture) => capture.read(item.data, snapshot.data, actor));
    },
  );
  return router;
}
