import { Router } from 'express';
import { z } from 'zod';
import {
  StagingFeaturePlan,
  StagingFeatureRequest,
  StagingFeatureToken,
  type StagingFeatureOwner,
} from './staging-feature-owner.js';
const planBody = z.strictObject({
  request: StagingFeatureRequest,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
});
const runBody = z.strictObject({ plan: StagingFeaturePlan, token: StagingFeatureToken });
/** Authentication is supplied by the existing app mount. There is no public
 * install/enrollment/configuration endpoint and no provider/model overrides. */
export function createStagingFeatureRouter(currentOwner: () => StagingFeatureOwner | undefined) {
  const router = Router();
  router.use((_req, res, next) => {
    if (!currentOwner()) {
      res.status(503).json({ error: 'Qualified staging feature owner unavailable' });
      return;
    }
    next();
  });
  router.get('/enrollments/:profileId', (req, res) => {
    try {
      res.json(currentOwner()!.enrollment(req.params.profileId));
    } catch {
      res.status(409).json({ error: 'Staging feature enrollment unavailable' });
    }
  });
  router.post('/plan', (req, res) => {
    const input = planBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Bounded staging feature plan required' });
      return;
    }
    try {
      res.json(currentOwner()!.plan(input.data.request, input.data.sourceCommit));
    } catch {
      res.status(409).json({ error: 'Staging feature plan unavailable' });
    }
  });
  router.post('/run', async (req, res) => {
    const input = runBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Bounded staging feature run required' });
      return;
    }
    try {
      res.json(await currentOwner()!.run(input.data.plan, input.data.token));
    } catch {
      res.status(409).json({ error: 'Staging feature run requires original-owner reconciliation' });
    }
  });
  router.get('/runs/:runId', (req, res) => {
    try {
      res.json(currentOwner()!.receipt(req.params.runId));
    } catch {
      res.status(409).json({ error: 'Original-owner feature receipt unavailable' });
    }
  });
  return router;
}
