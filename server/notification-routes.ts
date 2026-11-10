import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NotificationFilter, NotificationPreferences } from '@mitzo/protocol';
import type { NotificationCenter } from './notification-center.js';
import { operatorAuthMiddleware } from './auth.js';
import {
  getPendingSessionId,
  getPendingRequestsBySession,
  hasPending,
  resolvePending,
} from './permissions.js';
import { reconcileInbox } from './inbox-reconciliation.js';
import {
  nativeApprovalActions,
  validNativeNotificationAction,
} from './native-notification-action.js';
import type { NotificationResponseReceipt } from './notification-response-receipts.js';
import { createLogger } from './logger.js';
const log = createLogger('notification-response');
const responseBody = z
  .object({
    sessionId: z.string().min(1),
    decision: z.enum(['once', 'always', 'deny']),
    answers: z.record(z.string(), z.array(z.string().max(4000)).max(9)).optional(),
    requestId: z.uuid().optional(),
    nativeAction: z.enum(nativeApprovalActions).optional(),
    reviewed: z
      .object({
        toolName: z.string().min(1).max(200),
        toolInput: z.string().max(768),
        sessionGrantDescription: z.string().max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      [body.requestId, body.nativeAction, body.reviewed].every(Boolean) ||
      [body.requestId, body.nativeAction, body.reviewed].every((value) => value === undefined),
  );

function receiptResult(receipt: NotificationResponseReceipt) {
  return {
    ok:
      receipt.status === 'settled' &&
      receipt.resolution === (receipt.decision === 'deny' ? 'denied' : 'allowed'),
    receipt,
  };
}
export function notificationRouter(center: NotificationCenter): Router {
  const router = Router();
  router.use(operatorAuthMiddleware);
  const reconcileSources = reconcileInbox(center);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', reconcileSources, (req, res) => {
    const query = z
      .object({
        filter: NotificationFilter.default('all'),
        limit: z.coerce.number().int().min(1).max(100).default(100),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid notification filter' });
    res.json(center.feed(query.data.filter, query.data.limit, query.data.offset));
  });
  router.put('/preferences', (req, res) => {
    const parsed = NotificationPreferences.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid notification preferences' });
    const preferences = center.store.setPreferences(parsed.data);
    center.changed();
    res.json(preferences);
  });
  router.post('/read-updates', (_req, res) => {
    center.store.markUpdatesRead();
    center.changed();
    res.json({ ok: true });
  });
  router.post('/archive-resolved', reconcileSources, operatorAuthMiddleware, (_req, res) => {
    center.reconcile();
    const archived = center.store.archiveResolved();
    center.changed();
    res.json({ ok: true, archived });
  });
  router.post('/:id/archive', reconcileSources, operatorAuthMiddleware, (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string')
      return res.status(400).json({ error: 'A single notification ID is required.' });
    center.reconcile();
    if (!center.store.get(id)) return res.status(404).json({ error: 'Notification not found' });
    if (!center.store.archive(id))
      return res.status(409).json({ error: 'Resolve this request before archiving it.' });
    center.changed();
    res.json({ ok: true });
  });
  router.post('/:id/restore', (req, res) => {
    if (!center.store.restore(req.params.id))
      return res.status(404).json({ error: 'Notification not found' });
    center.changed();
    res.json({ ok: true });
  });
  router.post('/test', (_req, res) => res.status(202).json({ id: center.test() }));
  router.get(
    '/:id',
    (req, res, next) => {
      if (req.params.id.startsWith('inbox:')) return reconcileSources(req, res, next);
      next();
    },
    (req, res) => {
      center.reconcile();
      const item = center.store.get(req.params.id);
      if (!item) return res.status(404).json({ error: 'Notification not found' });
      res.json(item);
    },
  );
  router.post('/:id/read', (req, res) => {
    if (!center.store.markRead(req.params.id))
      return res.status(404).json({ error: 'Notification not found' });
    center.changed();
    res.json({ ok: true });
  });
  router.get('/:id/responses/:requestId', (req, res) => {
    const found = center.store.responses.get(req.params.requestId);
    if (
      !found ||
      found.receipt.notificationId !== req.params.id ||
      found.receipt.sessionId !== req.query.sessionId
    )
      return res.status(404).json({ code: 'approval_receipt_missing' });
    res.json(receiptResult(found.receipt));
  });
  router.post('/:id/respond', (req, res) => {
    const parsed = responseBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid response' });
    const body = parsed.data;
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (body.requestId) {
      const found = center.store.responses.get(body.requestId);
      if (found) {
        if (found.fingerprint !== fingerprint || found.receipt.notificationId !== req.params.id)
          return res.status(409).json({ code: 'approval_response_conflict' });
        return res.json(receiptResult(found.receipt));
      }
    }
    center.reconcile();
    const item = center.store.get(req.params.id);
    let receipt: NotificationResponseReceipt | undefined;
    if (body.requestId && body.nativeAction && item?.sessionId === body.sessionId && item.permId) {
      receipt = {
        requestId: body.requestId,
        notificationId: item.id,
        sessionId: body.sessionId,
        nativeAction: body.nativeAction,
        decision: body.decision,
        receivedAt: Date.now(),
        status: 'received',
      };
      center.store.responses.begin(receipt, fingerprint);
      log.info('Native notification response received', {
        requestId: receipt.requestId,
        sessionId: item.sessionId,
        permId: item.permId,
        nativeAction: receipt.nativeAction,
        decision: receipt.decision,
      });
    }
    const reject = (code: string, status = 409) => {
      if (receipt) {
        receipt = {
          ...receipt,
          status: 'rejected',
          code,
          settledAt: Date.now(),
          ...(item?.resolution === 'expired' ? { resolution: 'expired' as const } : {}),
        };
        center.store.responses.finish(receipt);
        return res.status(status).json(receiptResult(receipt));
      }
      return res
        .status(status)
        .json({ ok: false, code, error: 'Review the current request before responding.' });
    };
    if (
      !item?.permId ||
      item.resolvedAt !== null ||
      item.sessionId !== parsed.data.sessionId ||
      !hasPending(item.permId) ||
      getPendingSessionId(item.permId) !== item.sessionId
    )
      return reject('approval_not_pending');
    if (
      body.nativeAction &&
      body.reviewed &&
      !validNativeNotificationAction(
        getPendingRequestsBySession(item.sessionId).find(
          (request) => request.permId === item.permId,
        ),
        body.nativeAction,
        body.decision,
        body.reviewed,
      )
    )
      return reject('approval_scope_changed');
    if (parsed.data.decision === 'once' && item.request?.approvalScope === 'conversation')
      return res.status(400).json({ error: 'Review conversation-scoped access in the session.' });
    if (parsed.data.decision === 'always' && item.request?.questions)
      return res
        .status(400)
        .json({ error: 'Questions require an answer, not session authorization.' });
    try {
      if (!resolvePending(item.permId, body.decision, body.answers, item.sessionId))
        return reject('approval_not_applied', 400);
    } catch (cause) {
      // Preserve the original Error/correlation internally; never expose its text.
      log.error('Notification approval settlement failed', {
        err: cause,
        requestId: body.requestId,
        notificationId: item.id,
        sessionId: item.sessionId,
        permId: item.permId,
      });
      if (receipt) {
        receipt = {
          ...receipt,
          status: 'unconfirmed',
          code: 'approval_settlement_failed',
          settledAt: Date.now(),
        };
        center.store.responses.finish(receipt);
        return res.status(503).json(receiptResult(receipt));
      }
      return res.status(503).json({ ok: false, code: 'approval_settlement_failed' });
    }
    if (receipt) {
      const resolution = center.store.get(item.id)?.resolution;
      receipt = {
        ...receipt,
        settledAt: Date.now(),
        status: resolution ? 'settled' : 'unconfirmed',
        ...(resolution ? { resolution } : { code: 'approval_settlement_unconfirmed' }),
      };
      center.store.responses.finish(receipt);
      log.info('Native notification response settled', {
        requestId: receipt.requestId,
        sessionId: item.sessionId,
        permId: item.permId,
        nativeAction: receipt.nativeAction,
        decision: receipt.decision,
        status: receipt.status,
        resolution: receipt.resolution,
      });
      return res.json(receiptResult(receipt));
    }
    res.json({ ok: true });
  });
  return router;
}
