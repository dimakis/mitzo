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
import { TelosSourceApproval, TelosSourceSaveUncertainError } from './telos-source-approval.js';
import { TelosSourceApprovalStore } from './telos-source-approval-store.js';
import { z } from 'zod';
import type { Request } from 'express';
import {
  TelosSourcePermissionPreviewRequestSchema,
  TelosSourcePermissionApproveRequestSchema,
} from '@mitzo/protocol';

/** Host-authenticated source selection/adoption only. No HTTP source bytes,
 * caller actors, model settings, allocator receipts or internal-token fallback.
 */
export function createTelosSourceRouter(options: {
  dbPath(): string;
  events: EventStore;
  operatorAuth: RequestHandler;
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
  createOutcome?(input: TelosOutcomeCreation): Promise<{ itemId: string }>;
  verifyInternal?(req: Request): boolean;
  sessionId?(clientId: string): string | undefined;
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
    action: (capture: TelosSourceCapture, approval: TelosSourceApproval) => unknown,
  ) => {
    let work: TelosWorkStore | undefined, artifacts: TelosArtifactStore | undefined;
    let approvalStore: TelosSourceApprovalStore | undefined;
    try {
      const path = options.dbPath();
      work = new TelosWorkStore(path, {
        ordinaryConversation: options.ordinaryConversation,
        sourceConversation: options.sourceConversation,
      });
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
      approvalStore = new TelosSourceApprovalStore(path);
      const approval = new TelosSourceApproval({
        events: options.events,
        work,
        artifacts,
        store: approvalStore,
        createOutcome: async (input) => {
          if (!options.createOutcome) throw new Error('Canonical creator unavailable');
          return options.createOutcome(input);
        },
      });
      res.json(await action(capture, approval));
    } catch (error) {
      const known = error instanceof TelosWorkError;
      const uncertain = error instanceof TelosSourceSaveUncertainError;
      res
        .status(
          known
            ? { not_found: 404, unauthorized: 403, conflict: 409, invalid: 400 }[error.code]
            : 503,
        )
        .json({
          code: known ? error.code : uncertain ? 'save_uncertain' : 'unavailable',
          error: known || uncertain ? error.message : 'Reviewed source service unavailable',
        });
    } finally {
      artifacts?.close();
      work?.close();
      approvalStore?.close();
    }
  };
  router.get(
    '/api/telos/work/source/permissions/:permId',
    options.operatorAuth,
    async (req, res) => {
      const actor = authority(res);
      if (!actor) return;
      const input = z
        .strictObject({
          permId: TelosWorkIdSchema,
          sessionId: TelosWorkIdSchema,
          afterSequence: z.coerce.number().int().nonnegative().safe().default(0),
        })
        .safeParse({ permId: req.params.permId, ...req.query });
      if (!input.success) {
        res.status(400).json({ code: 'invalid', error: 'Invalid source permission' });
        return;
      }
      await run(res, actor, (_capture, approval) =>
        approval.review(input.data.permId, input.data.sessionId, actor, input.data.afterSequence),
      );
    },
  );
  for (const operation of ['preview', 'approve'] as const)
    router.post(
      '/api/telos/work/source/permissions/:permId/' + operation,
      options.operatorAuth,
      requireSameOriginJson,
      async (req, res) => {
        const actor = authority(res);
        if (!actor) return;
        const id = TelosWorkIdSchema.safeParse(req.params.permId),
          input = (
            operation === 'preview'
              ? TelosSourcePermissionPreviewRequestSchema
              : TelosSourcePermissionApproveRequestSchema
          ).safeParse(req.body);
        if (!id.success || !input.success) {
          res.status(400).json({ code: 'invalid', error: 'Invalid source permission request' });
          return;
        }
        await run(res, actor, (_capture, approval) =>
          operation === 'preview'
            ? approval.preview(id.data, input.data, actor)
            : approval.approve(id.data, input.data, actor),
        );
      },
    );
  router.post('/api/internal/telos/source/execute', async (req, res) => {
    if (!options.verifyInternal?.(req)) {
      res.status(401).json({ code: 'unauthorized', error: 'Internal token required' });
      return;
    }
    const sessionId = options.sessionId?.(String(req.headers['x-client-id'] ?? ''));
    if (!sessionId) {
      res
        .status(409)
        .json({ code: 'unavailable', error: 'Active Mitzo source conversation required' });
      return;
    }
    const input = z
      .strictObject({
        approvalReceiptId: z.uuid(),
        proposal: z.record(z.string(), z.unknown()),
        operation: z.enum(['create', 'adopt']),
      })
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'invalid', error: 'Reviewed source receipt required' });
      return;
    }
    await run(res, { kind: 'conversation', id: sessionId }, (_capture, approval) => {
      const receipt = approval.execute(
        input.data.approvalReceiptId,
        sessionId,
        input.data.proposal,
      );
      if (receipt.operation.kind !== input.data.operation)
        throw new TelosWorkError('unauthorized', 'Reviewed source operation differs');
      return receipt;
    });
  });
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
