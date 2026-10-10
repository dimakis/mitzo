import { Router, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { AgentLibraryStore } from './agent-library-store.js';
import { PortableProfileDefinitionSchema } from './symposium-profile-portability.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';

const OWNER = 'user'; // Stable authenticated subject, never the rotating login JTI.
function failure(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'Agent Library request failed';
  const status =
    error instanceof ZodError
      ? 400
      : /conflict|idempotency/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 400;
  res.status(status).json({ error: message });
}
export function createAgentLibraryRouter(store: AgentLibraryStore): Router {
  const router = Router();
  router.use((_req, res, next) => {
    if (!res.locals.authSession)
      return res.status(403).json({ error: 'Interactive operator authentication is required' });
    next();
  });
  router.get('/', (_req, res) => {
    try {
      res.json(store.list(OWNER));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/drafts', (req, res) => {
    try {
      res.json(store.saveDraft(OWNER, req.body));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/publish', (req, res) => {
    try {
      res.json(store.publish(OWNER, req.body));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/import', (req, res) => {
    try {
      res.json(store.importDraft(OWNER, req.body));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/preview', (req, res) => {
    try {
      const { definition } = z
        .strictObject({ definition: PortableProfileDefinitionSchema })
        .parse(req.body);
      res.json({
        profilePrompt: buildAgentProfilePrompt(definition),
        contextResolved: false,
        recipe: definition.recipe ?? null,
      });
    } catch (error) {
      failure(res, error);
    }
  });
  const version = (profileId: string, revision: string) => {
    const selected = store.version(
      OWNER,
      profileId,
      z.coerce.number().int().positive().parse(revision),
    );
    if (!selected) throw Error('Profile revision not found');
    return selected;
  };
  router.get('/:profileId/:revision/export', (req, res) => {
    try {
      res.json(version(req.params.profileId, req.params.revision));
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/:profileId/:revision', (req, res) => {
    try {
      res.json(version(req.params.profileId, req.params.revision));
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
