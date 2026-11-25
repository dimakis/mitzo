import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PrMonitorRegisterSchema, type PrMonitorController } from './pr-monitor-controller.js';
import { createLogger } from './logger.js';
import {
  recentAuthorizationSession,
  requireRecentConnectionAuthorization,
  requireSameOriginJson,
} from './connections-router.js';
import { z } from 'zod';
import { PrMonitorAuthoritySchema } from '@mitzo/protocol';
const watchChange = z.strictObject({
  requestId: z.string().min(1).max(200),
  expectedRevision: z.number().int().positive(),
  expectedAuthorityRevision: z.number().int().nonnegative(),
  durationMinutes: z.number().int().min(1).max(480),
  reviewedScope: PrMonitorAuthoritySchema.shape.scope,
  csrf: z.string().optional(),
});
const watchRevoke = watchChange.pick({
  requestId: true,
  expectedRevision: true,
  expectedAuthorityRevision: true,
});
const log = createLogger('session-capability-router');
import {
  CreateSessionCapabilityGrant,
  type SessionCapabilityGrants,
  type SessionCapabilityInventory,
} from './session-capability-grants.js';

/** Interactive operator route only. Internal tool credentials cannot create
 * grants. The custom header forces a browser preflight on cross-origin writes. */
export function createSessionCapabilityRouter(options: {
  grants: SessionCapabilityGrants;
  monitor?: PrMonitorController;
  hasSession(id: string): boolean;
  title?(id: string): string | undefined;
}) {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    const id = req.params.id;
    if (typeof id !== 'string' || !options.hasSession(id))
      return res.status(404).json({ error: 'Conversation not found' });
    if (req.method !== 'GET' && req.get('X-Mitzo-Access-Intent') !== 'manage-grants')
      return res.status(403).json({ error: 'Use the Access controls to change grants' });
    // Retained status and revocation depend on current interactive operator
    // authentication, not on a running conversation or available account.
    if (
      (req.method === 'GET' && req.path === '/pr-monitor') ||
      (req.method === 'POST' && /^\/pr-watch\/[a-f0-9-]+\/revoke$/.test(req.path))
    ) {
      next();
      return;
    }
    try {
      options.grants.list(auth.id, id);
    } catch {
      return res.status(409).json({
        error:
          'Live access for this login is unavailable. Reconnect the conversation and refresh Access.',
      });
    }
    next();
  });
  router.get<{ id: string }>('/pr-monitor', (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    if (!options.monitor) return res.status(503).json({ code: 'pr_watch_unavailable' });
    try {
      const id = req.params.id as string;
      return res.json({
        ...options.monitor.context(auth, id),
        subscriptions: options.monitor.list(auth, id),
      });
    } catch {
      return res.status(409).json({
        code: 'pr_observation_unavailable',
        error: 'Refresh the conversation and its account before managing Watch.',
      });
    }
  });
  router.post(
    '/pr-monitor',
    rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }),
    requireSameOriginJson,
    async (req, res) => {
      const auth = recentAuthorizationSession(res);
      if (!auth) return;
      if (!options.monitor) return res.status(503).json({ code: 'pr_watch_unavailable' });
      const parsed = PrMonitorRegisterSchema.extend({ csrf: z.string().optional() }).safeParse(
        req.body,
      );
      if (!parsed.success) return res.status(400).json({ code: 'invalid_watch_request' });
      if (!requireRecentConnectionAuthorization(res, parsed.data.csrf ?? '')) return;
      try {
        const input = { ...parsed.data };
        delete input.csrf;
        return res
          .status(201)
          .json(await options.monitor.register(auth, req.params.id as string, input));
      } catch (error) {
        const quotaBlocked = error instanceof Error && ['quota_delayed', 'quota_retention_limit'].includes(error.message);
        log.warn('PR registration could not retain verified scope', {
          stage: 'register',
          code: quotaBlocked ? error.message : 'pr_registration_unavailable',
          conversationId: req.params.id,
        });
        return res.status(409).json({
          code: 'pr_registration_unavailable',
          error: quotaBlocked
            ? 'GitHub reads are temporarily blocked by shared quota or retained reservation capacity. Wait for backoff, then retry the same registration request.'
            : 'Registration was not confirmed. Refresh account/repository access and retry the same request.',
        });
      }
    },
  );
  router.get<{ id: string }>('/', (req, res) => {
    const id = req.params.id as string;
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    res.json({
      sessionId: id,
      observedAt: Date.now(),
      grants: options.grants.list(auth.id, id),
      sessions: options.grants
        .candidates(auth.id)
        .filter((s) => options.hasSession(s.sessionId))
        .map((s) => ({ ...s, title: options.title?.(s.sessionId) ?? s.sessionId })),
      automaticReview: {
        state: 'unavailable',
        reason:
          'Automatic approval review needs a verified reviewer model, account and billing route. Human review handles remaining requests.',
      },
    } satisfies SessionCapabilityInventory);
  });
  router.post<{ id: string; subscriptionId: string }>('/pr-watch/:subscriptionId', (req, res) => {
    if (!options.grants.prWatchAvailable)
      return res.status(503).json({
        code: 'pr_watch_unavailable',
        error: 'Durable Watch consent and authenticated connection adapters are not installed.',
      });
    return requireSameOriginJson(req, res, () => {
      const auth = recentAuthorizationSession(res);
      if (!auth) return;
      const parsed = watchChange.safeParse(req.body);
      if (!parsed.success || !z.uuid().safeParse(req.params.subscriptionId).success)
        return res.status(400).json({ code: 'invalid_watch_request' });
      if (!requireRecentConnectionAuthorization(res, parsed.data.csrf ?? '')) return;
      const input = watchChange.omit({ csrf: true }).parse({
        requestId: parsed.data.requestId,
        expectedRevision: parsed.data.expectedRevision,
        expectedAuthorityRevision: parsed.data.expectedAuthorityRevision,
        durationMinutes: parsed.data.durationMinutes,
        reviewedScope: parsed.data.reviewedScope,
      });
      try {
        return res.status(201).json(
          options.grants.issuePrWatch(auth, {
            ...input,
            conversationId: req.params.id as string,
            subscriptionId: req.params.subscriptionId as string,
          }),
        );
      } catch {
        return res.status(409).json({
          code: 'watch_scope_changed',
          error: 'Refresh the selected PR and review Watch access again.',
        });
      }
    });
  });
  router.post('/pr-watch/:subscriptionId/revoke', requireSameOriginJson, (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    if (!options.grants.prWatchAvailable)
      return res.status(503).json({ code: 'pr_watch_unavailable' });
    const parsed = watchRevoke.safeParse(req.body);
    if (!parsed.success || !z.uuid().safeParse(req.params.subscriptionId).success)
      return res.status(400).json({ code: 'invalid_watch_request' });
    try {
      return res.json(
        options.grants.revokePrWatch(auth, {
          ...parsed.data,
          conversationId: req.params.id as string,
          subscriptionId: req.params.subscriptionId as string,
        }),
      );
    } catch {
      return res.status(409).json({
        code: 'watch_revoke_unconfirmed',
        error: 'Watch revocation was not confirmed. Refresh and retry the same request.',
      });
    }
  });
  router.post<{ id: string }>('/', (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    const parsed = CreateSessionCapabilityGrant.safeParse(req.body);
    if (
      !parsed.success ||
      !parsed.data.expectedContexts ||
      !parsed.data.sessionIds.includes(req.params.id as string) ||
      parsed.data.sessionIds.some((id) => !options.hasSession(id))
    )
      return res.status(400).json({
        error:
          'Select this conversation, the capability, duration and any other visible conversations explicitly',
      });
    try {
      return res.status(201).json(options.grants.create(auth.id, parsed.data));
    } catch {
      return res.status(409).json({
        error:
          'Access changed or a selected folder is protected. Refresh Access and check the selected conversations and folders.',
      });
    }
  });
  router.delete<{ id: string; grantId: string }>('/:grantId', async (req, res) => {
    const auth = recentAuthorizationSession(res);
    if (!auth) return;
    try {
      await options.grants.revoke(auth.id, req.params.id as string, req.params.grantId as string);
      return res.sendStatus(204);
    } catch {
      return res.status(409).json({
        error:
          'Grant revoked or unavailable. Refresh Access; a running command may need to be stopped.',
      });
    }
  });
  return router;
}
