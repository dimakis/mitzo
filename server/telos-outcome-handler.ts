import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { TelosOutcomeProposalSchema, type TelosOutcomeCreation } from '@mitzo/protocol';
import type { TelosWorkActor } from './telos-work-store.js';

/** Legacy tool transport: host binding proves the origin, never a client/provider
 * ID or caller actor. A legacy approval has no reviewed message selection; this
 * path records only the known origin and cannot read source packets or dispatch. */
export function createTelosOutcomeHandler(options: {
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
  availableSource(id: string): boolean;
  createOutcome(input: TelosOutcomeCreation): Promise<{ itemId: string }>;
  recordOrigin(input: { itemId: string; idempotencyKey: string }, actor: TelosWorkActor): void;
}): RequestHandler {
  return async (req, res) => {
    if (!options.verifyInternal(req)) {
      res.status(401).json({ ok: false, error: 'Internal token required' });
      return;
    }
    const sessionId = options.sessionId(String(req.headers['x-client-id'] ?? ''));
    if (!sessionId || !options.availableSource(sessionId)) {
      res.status(409).json({ ok: false, error: 'Active Mitzo source conversation required' });
      return;
    }
    const parsed = TelosOutcomeProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid outcome input' });
      return;
    }
    const idempotencyKey =
      sessionId + ':' + createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    const hints = parsed.data.contextHints;
    try {
      const created = await options.createOutcome({
        ...parsed.data,
        idempotencyKey,
        contextHints: {
          ...hints,
          sessionIds: [...new Set([...(hints?.sessionIds ?? []), sessionId])],
        },
      });
      options.recordOrigin(
        { itemId: created.itemId, idempotencyKey },
        { kind: 'conversation', id: sessionId },
      );
      res.json({ ok: true, item: { id: created.itemId, summary: parsed.data.summary } });
    } catch {
      res.status(503).json({
        ok: false,
        error:
          'Outcome save uncertain. Retry the same approved request to recover its original item.',
      });
    }
  };
}
