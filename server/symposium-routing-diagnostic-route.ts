import { z } from 'zod';
import type { RequestHandler } from 'express';
import { registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import {
  PersonalConnectionSchema,
  type PersonalConnection,
} from './symposium-personal-connections.js';
import {
  RoutingDiagnosticResultSchema,
  type RoutingDiagnosticResult,
} from './symposium-model-discovery.js';

export type PersonalRoutingDiagnosticOperation = (
  id: string,
  revision: number,
  assertOperator: () => void,
) => Promise<RoutingDiagnosticResult & { connection?: PersonalConnection }>;
const Body = z.strictObject({ expectedRevision: z.number().int().positive().safe() });
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Response = RoutingDiagnosticResultSchema.extend({
  connection: PersonalConnectionSchema.optional(),
});

/** Mount only behind interactive operator authentication. No caller logging,
 * provider, endpoint, native build or model choices cross this boundary. */
export function createPersonalRoutingDiagnosticHandler(
  resolve: () => PersonalRoutingDiagnosticOperation | undefined,
): RequestHandler[] {
  return [
    requireSameOriginJson,
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const body = Body.safeParse(req.body),
        id = Id.safeParse(req.params.id);
      if (!body.success || !id.success || Object.keys(req.query).length) {
        res
          .status(400)
          .json({ error: 'Provide only the exact current Personal connection revision.' });
        return;
      }
      const session = res.locals.authSession as AuthSession | undefined;
      if (!session || session.expiresAt <= Date.now()) {
        res.status(403).json({ error: 'Current interactive operator authentication required.' });
        return;
      }
      const diagnose = resolve();
      if (!diagnose) {
        res
          .status(503)
          .json({ error: 'Owned routing diagnostic is unavailable for this native build.' });
        return;
      }
      let current = true;
      const unregister = registerAuthSession(session, () => {
        current = false;
      });
      const close = () => {
        current = false;
        unregister();
      };
      res.once('close', close);
      res.once('finish', close);
      const assertOperator = () => {
        if (!current || res.writableEnded || session.expiresAt <= Date.now())
          throw new Error('Original diagnostic operator is unavailable');
      };
      try {
        assertOperator();
        const rawResult = await diagnose(id.data, body.data.expectedRevision, assertOperator);
        const result = Response.parse(rawResult);
        assertOperator();
        res
          .status(
            result.status === 'failed'
              ? 422
              : result.status === 'reconciliation_required'
                ? 409
                : 200,
          )
          .json(result);
      } catch {
        res.status(409).json({
          error:
            'Routing diagnostic is unavailable or requires recovery. Refresh connection status before retry.',
        });
      } finally {
        close();
        res.off('close', close);
        res.off('finish', close);
      }
    },
  ];
}
