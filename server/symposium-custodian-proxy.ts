import type { CapabilityApproval } from './connections/capabilities/types.js';
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
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
  request(
    input: Omit<CustodianRequest, 'epoch'>,
    approval?: CapabilityApproval,
    signal?: AbortSignal,
  ): Promise<CustodianResponse>;
  invalidate(jti: string): void;
}
export function createCustodianProxy(
  client: CustodianClient,
  publicationApproval?: (
    req: Request,
    auth: AuthSession,
    sessionId: string,
  ) => CapabilityApproval | undefined,
): RequestHandler {
  return (req, res, next) => {
    const selected = selectCustodianOperation(req.method, req.path);
    if (!selected) {
      // Express decodes parameters and matches routes case-insensitively. The
      // controller must never fall through to a local owner for those aliases.
      const localReauthorization =
        req.method === 'POST' &&
        /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\/symposium\/(?:source\/reauthorize|creation\/recovery\/app-reauthorize|publication\/recovery\/reauthorize)$/.test(
          req.path,
        );
      if (localReauthorization) return next();
      let decoded = req.path;
      try {
        decoded = decodeURIComponent(req.path);
      } catch {
        /* Original namespace remains fenced. */
      }
      const protectedNamespace =
        /^\/api\/(?:symposium(?:\/|$)|sessions\/[^/]+\/symposium(?:\/|$))/i;
      if (protectedNamespace.test(req.path) || protectedNamespace.test(decoded)) {
        res.status(400).json({ error: 'Unsupported custodian request' });
        return;
      }
      return next();
    }
    void operatorAuthMiddleware(req, res, () => {
      const execute = async () => {
        const auth = res.locals.authSession as AuthSession;
        const csrf = req.header('x-csrf-token') ?? '';
        if (
          [
            'source.import',
            'source.sealRecover',
            'director.authorizeRecovery',
            'publication.recover',
          ].includes(selected.operation) &&
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
          const parsed = decodeCustodianRequest({
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
          input = {
            ...selected,
            requestId: parsed.requestId,
            query: parsed.query,
            body: parsed.body,
            authorization: parsed.authorization,
          };
        } catch {
          res.status(400).json({ error: 'Invalid custodian request' });
          return;
        }
        const disconnected = new AbortController();
        const close = () => {
          if (!res.writableEnded) disconnected.abort();
        };
        res.on('close', close);
        let invalidated = false;
        const unregister = registerAuthSession(auth, () => {
          invalidated = true;
          client.invalidate(auth.id);
        });
        try {
          const approval =
            selected.operation === 'publication.publish' && selected.sessionId
              ? publicationApproval?.(req, auth, selected.sessionId)
              : undefined;
          if (selected.operation === 'publication.publish' && !approval) {
            res
              .status(409)
              .json({ error: 'Authenticated publication controller approval unavailable' });
            return;
          }
          const result = await client.request(
            input,
            approval &&
              (async (request, signal) => {
                if (invalidated || auth.expiresAt <= Date.now())
                  throw Error('Operator authorization expired');
                const allowed = await approval(request, signal);
                if (invalidated || auth.expiresAt <= Date.now())
                  throw Error('Operator authorization expired');
                return allowed;
              }),
            disconnected.signal,
          );
          if (invalidated || auth.expiresAt <= Date.now()) {
            res.status(403).json({ error: 'Operator authorization expired or revoked' });
            return;
          }
          res.status(result.status).json(result.body);
        } catch {
          res.status(503).json({
            error:
              'Symposium custodian unavailable; check retained operation status before retrying',
          });
        } finally {
          res.off('close', close);
          disconnected.abort();
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
