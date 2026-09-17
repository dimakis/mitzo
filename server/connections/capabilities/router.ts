import express from 'express';
import { z } from 'zod';
import type { CapabilityService } from './service.js';
import type { CapabilityApproval } from './types.js';
import {
  requireRecentConnectionAuthorization,
  requireSameOriginJson,
  recentAuthorizationSession,
} from '../../connections-router.js';

const RequestBody = z
  .object({
    capabilityId: z.string().min(1).max(128),
    capabilityVersion: z.number().int().positive(),
    connectionId: z.string().min(1).max(128),
    connectionRevision: z.number().int().positive(),
    conversationId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(256),
    input: z.unknown(),
  })
  .strict();
const SubjectBody = z.object({ conversationId: z.string().min(1).max(256) }).strict();

/**
 * HTTP is deliberately a thin adapter. Direct Codex callers invoke the exact
 * same CapabilityService, so input validation, authorization, audit, and
 * idempotency cannot drift between paths.
 */
export function createCapabilityOperationsRouter(options: {
  service: CapabilityService;
  /** Authoritative lifecycle lookup; it also rejects conversations not owned by the session. */
  resolveConversationBinding(
    sessionId: string,
    conversationId: string,
  ): { accountId: string } | undefined;
  sessionId(req: express.Request, res: express.Response): string | undefined;
  /** Must display a forced, conversation-bound Mitzo approval card. */
  approveForConversation(conversationId: string): CapabilityApproval;
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (recentAuthorizationSession(res)) next();
  });
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return requireSameOriginJson(req, res, next);
  });
  router.use(express.json({ limit: '32kb' }));
  const subject = (req: express.Request, res: express.Response, conversationId: string) => {
    const id = options.sessionId(req, res);
    return id ? options.resolveConversationBinding(id, conversationId) : undefined;
  };
  router.post('/', async (req, res) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid capability operation' });
    const trusted = subject(req, res, parsed.data.conversationId);
    if (!trusted) return res.status(403).json({ error: 'Capability access denied' });
    if (!requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? '')) return;
    try {
      return res.status(202).json({
        operation: await options.service.invoke(
          { ...parsed.data, accountId: trusted.accountId },
          AbortSignal.timeout(120_000),
          options.approveForConversation(parsed.data.conversationId),
        ),
      });
    } catch {
      return res.status(422).json({ error: 'Capability operation rejected' });
    }
  });
  router.get('/:id', (req, res) => {
    const parsed = SubjectBody.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid capability operation' });
    const trusted = subject(req, res, parsed.data.conversationId);
    if (!trusted) return res.status(403).json({ error: 'Capability access denied' });
    const operation = options.service.getOperation(
      req.params.id,
      trusted.accountId,
      parsed.data.conversationId,
    );
    return operation
      ? res.json({ operation })
      : res.status(404).json({ error: 'Capability operation not found' });
  });
  router.post('/:id/cancel', (req, res) => {
    const parsed = SubjectBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid capability operation' });
    const trusted = subject(req, res, parsed.data.conversationId);
    if (!trusted) return res.status(403).json({ error: 'Capability access denied' });
    if (!requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? '')) return;
    const operation = options.service.cancel(
      req.params.id,
      trusted.accountId,
      parsed.data.conversationId,
    );
    return operation
      ? res.json({ operation })
      : res.status(404).json({ error: 'Capability operation not found' });
  });
  return router;
}
