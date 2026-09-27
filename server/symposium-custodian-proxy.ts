import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { operatorAuthMiddleware, registerAuthSession, type AuthSession } from './auth.js';
import {
  requireSameOriginJson,
  requireRecentConnectionAuthorization,
  recentAuthorizationExpiry,
} from './connections-router.js';
import {
  decodeCustodianRequest,
  selectCustodianOperation,
  type CustodianRequest,
} from './symposium-custodian-protocol.js';
import type { CustodianResponse } from './symposium-custodian-controller.js';
export interface CustodianClient {
  request(input: Omit<CustodianRequest, 'epoch'>): Promise<CustodianResponse>;
  invalidate(jti: string): void;
}
export function createCustodianProxy(client: CustodianClient): RequestHandler {
  return (req, res, next) => {
    const selected = selectCustodianOperation(req.method, req.path);
    if (!selected) return next();
    void operatorAuthMiddleware(req, res, () => {
      const execute = async () => {
        const auth = res.locals.authSession as AuthSession;
        const csrf = req.header('x-csrf-token') ?? '';
        if (
          ['source.import', 'director.authorizeRecovery'].includes(selected.operation) &&
          !requireRecentConnectionAuthorization(res, csrf)
        )
          return;
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.query)) {
          if (typeof value !== 'string') {
            res.status(400).json({ error: 'Invalid custodian query' });
            return;
          }
          query[key] = value;
        }
        let input: Omit<CustodianRequest, 'epoch'>;
        try {
          const recentUntil = recentAuthorizationExpiry(res, csrf);
          const { epoch: _epoch, ...parsed } = decodeCustodianRequest({
            ...selected,
            epoch: 1,
            requestId: randomUUID(),
            query,
            body: req.body ?? {},
            authorization: {
              id: auth.id,
              expiresAt: auth.expiresAt,
              ...(recentUntil ? { recentUntil } : {}),
            },
          });
          input = parsed;
        } catch {
          res.status(400).json({ error: 'Invalid custodian request' });
          return;
        }
        let invalidated = false;
        const unregister = registerAuthSession(auth, () => {
          invalidated = true;
          client.invalidate(auth.id);
        });
        try {
          const result = await client.request(input);
          if (invalidated || auth.expiresAt <= Date.now()) {
            res.status(403).json({ error: 'Operator authorization expired or revoked' });
            return;
          }
          res.status(result.status).json(result.body);
        } catch {
          res
            .status(503)
            .json({
              error:
                'Symposium custodian unavailable; check retained operation status before retrying',
            });
        } finally {
          unregister();
        }
      };
      const run = () => {
        void execute().catch(next);
      };
      if (req.method === 'GET') run();
      else requireSameOriginJson(req, res, run);
    }).catch(next);
  };
}
