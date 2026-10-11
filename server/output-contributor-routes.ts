import { Router, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { AuthSession } from './auth.js';
import { withAgentLibraryRecoveryAuthorization } from './agent-library-transport.js';
import {
  type OutputContributors,
  OutputContributorAddInputSchema,
  OutputContributorMessageInputSchema,
  OutputContributorStopInputSchema,
  UnsupportedOutputContributorContextError,
  UNSUPPORTED_OUTPUT_CONTRIBUTOR_CONTEXT_MESSAGE,
} from './output-contributors.js';

function failure(res: Response, error: unknown) {
  if (error instanceof UnsupportedOutputContributorContextError) {
    res.status(409).json({ error: UNSUPPORTED_OUTPUT_CONTRIBUTOR_CONTEXT_MESSAGE });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: 'Invalid contributor input' });
    return;
  }
  if (
    error instanceof Error &&
    ['Output contributor not found', 'Session output not found'].includes(error.message)
  ) {
    res.status(404).json({ error: 'Output contributor or selected output not found' });
    return;
  }
  res.status(409).json({
    error:
      'Contributor operation could not complete. Check the selected output, account, saved guidance and current execution before retrying.',
  });
}
/** Mount behind interactive operator authentication at /api/sessions/:id/contributors. */
export function createOutputContributorRouter(options: {
  service: OutputContributors;
  hasSession(sessionId: string): boolean;
}) {
  const router = Router({ mergeParams: true });
  router.use((req: Request, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (typeof req.params.id !== 'string' || !options.hasSession(req.params.id as string)) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    next();
  });
  router.get('/', async (req: Request, res) => {
    try {
      res.json(await options.service.list(req.params.id as string));
    } catch {
      res.status(503).json({ error: 'Output contributors unavailable' });
    }
  });
  router.post('/', async (req: Request, res) => {
    const parsed = OutputContributorAddInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid contributor selection' });
      return;
    }
    try {
      // Profile admission belongs to this middleware-verified operator, never
      // a connection selector supplied by another browser or request body.
      const auth: AuthSession | undefined = res.locals.authSession;
      const contributor = await withAgentLibraryRecoveryAuthorization(
        auth,
        (operatorConnectionId) =>
          options.service.add(req.params.id as string, parsed.data, operatorConnectionId),
      );
      res.json({ contributor });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/:contributorId/messages', async (req: Request, res) => {
    const parsed = OutputContributorMessageInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid contributor message' });
      return;
    }
    try {
      res.json(
        await options.service.message(
          req.params.id as string,
          req.params.contributorId as string,
          parsed.data,
        ),
      );
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/:contributorId/stop', async (req: Request, res) => {
    const parsed = OutputContributorStopInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid contributor stop request' });
      return;
    }
    try {
      res.json({
        contributor: await options.service.stop(
          req.params.id as string,
          req.params.contributorId as string,
          parsed.data,
        ),
      });
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
