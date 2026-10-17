import { Router } from 'express';
import { z } from 'zod';
import type { ApiToolCatalog } from './api-tool-catalog.js';
import { apiToolTemplate } from './api-tool-template.js';
import type { CredentialConnections } from './credential-connections.js';
import { isAuthSessionCurrent, registerAuthSession, type AuthSession } from './auth.js';
import {
  requireSameOriginJson,
  requireRecentConnectionAuthorization,
  recentAuthorizationExpiry,
} from './connections-router.js';
import {
  custodianRequestAuthority,
  custodianRequestSignal,
} from './symposium-custodian-authority.js';
export type ApiToolOwner = { catalog: ApiToolCatalog; service: CredentialConnections };
const version = z.strictObject({ id: z.uuid(), version: z.number().int().positive() });
function project(draft: ReturnType<ApiToolCatalog['save']>) {
  return {
    id: draft.id,
    version: draft.version,
    configuration: draft.configuration,
    verified: !!draft.verification?.startsWith('verified:'),
  };
}
export function createApiToolRouter(current: () => ApiToolOwner | undefined) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || !isAuthSessionCurrent(auth))
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    next();
  });
  router.get('/', (_req, res) => {
    const owner = current();
    if (!owner)
      return res.status(503).json({
        error:
          'API tool configuration requires an active connection runtime. Open Connections to set it up.',
      });
    res.json({
      templates: [apiToolTemplate],
      drafts: owner.catalog.drafts().map(project),
      connections: owner.service
        .catalog()
        .filter(
          (c) =>
            c.serviceTemplate === 'home-assistant' &&
            c.status === 'active' &&
            c.methods.includes('GET'),
        )
        .map((c) => ({ id: c.id, label: c.label, endpoint: c.endpoint })),
    });
  });
  router.post('/drafts', requireSameOriginJson, (req, res) => {
    try {
      const owner = current();
      if (!owner) throw Error('API tool configuration unavailable');
      res.json({ draft: project(owner.catalog.save(req.body, owner.service)) });
    } catch {
      res.status(400).json({
        error:
          'Invalid configuration or draft version conflict. Reload the saved draft and check connection scope.',
      });
    }
  });
  router.post('/publish', requireSameOriginJson, (req, res) => {
    try {
      const owner = current();
      if (!owner) throw Error('API tool configuration unavailable');
      const body = version.parse(req.body);
      res.json({ tool: owner.catalog.publish(body.id, body.version, owner.service) });
    } catch {
      res.status(400).json({
        error: 'API tool publication requires the current saved draft and successful verification.',
      });
    }
  });
  router.post('/verify', requireSameOriginJson, async (req, res) => {
    const csrf = req.header('x-csrf-token') ?? '';
    if (!requireRecentConnectionAuthorization(res, csrf)) return;
    const auth = res.locals.authSession as AuthSession;
    const controller = new AbortController();
    const unregister = registerAuthSession(auth, () => controller.abort());
    const inherited = custodianRequestSignal(req);
    const signal = AbortSignal.any([
      controller.signal,
      ...(inherited ? [inherited] : []),
      AbortSignal.timeout(30000),
    ]);
    const close = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', close);
    try {
      const owner = current();
      if (!owner) throw Error('API tool configuration unavailable');
      const body = version.parse(req.body);
      const assertCurrent = () => {
        signal.throwIfAborted();
        const live = current();
        const until =
          custodianRequestAuthority(req)?.recentUntil ?? recentAuthorizationExpiry(res, csrf) ?? 0;
        if (
          !isAuthSessionCurrent(auth) ||
          until <= Date.now() ||
          live?.catalog !== owner.catalog ||
          live?.service !== owner.service
        )
          throw Error('API tool verification authority changed');
      };
      assertCurrent();
      const draft = await owner.catalog.verify(body.id, body.version, {
        service: owner.service,
        signal,
        assertCurrent,
      });
      assertCurrent();
      res.json({ draft: project(draft) });
    } catch {
      if (!res.destroyed)
        res.status(400).json({
          error:
            'API tool verification failed or was cancelled. Check connection access and response shape. Save the draft again after connection changes, then verify again.',
        });
    } finally {
      unregister();
      res.off('close', close);
    }
  });
  return router;
}
