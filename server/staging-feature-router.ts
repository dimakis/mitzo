import { captureCustodianRequestCurrent } from './symposium-custodian-authority.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  StagingFeaturePlan,
  StagingFeatureRequest,
  StagingFeatureToken,
} from './staging-feature-contract.js';
import type { StagingFeatureOwner } from './staging-feature-owner.js';
const planBody = z.strictObject({
  request: StagingFeatureRequest,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
});
const runBody = z.strictObject({ plan: StagingFeaturePlan, token: StagingFeatureToken });
/** Authentication is supplied by the existing app mount. There is no public
 * install/enrollment/configuration endpoint and no provider/model overrides. */
export type StagingFeatureOwnerProtocol = Pick<StagingFeatureOwner, 'enrollment' | 'receipt'> & {
  plan(
    request: unknown,
    sourceCommit: string,
  ): ReturnType<StagingFeatureOwner['plan']> | Promise<ReturnType<StagingFeatureOwner['plan']>>;
  run(
    plan: unknown,
    token: unknown,
    assertRequestCurrent?: () => void,
  ): ReturnType<StagingFeatureOwner['run']>;
} & {
  resources?: () => object;
};
export function createStagingFeatureRouter(
  currentOwner: () => StagingFeatureOwnerProtocol | undefined,
  currentNativeInference: () =>
    | Pick<
        import('./staging-native-inference-current-owner.js').StagingNativeInferenceCurrentOwner,
        'current'
      >
    | undefined = () => undefined,
) {
  const router = Router();
  router.use((_req, res, next) => {
    if (!currentOwner()) {
      res.status(503).json({ error: 'Qualified staging feature owner unavailable' });
      return;
    }
    next();
  });
  router.post('/native-inference/current', (req, res) => {
    res.setHeader('cache-control', 'no-store');
    try {
      const original = currentNativeInference();
      if (!original) throw Error('Original native inference owner unavailable');
      res.json(original.current({ method: req.method, url: req.originalUrl }, req.body));
    } catch {
      res.status(503).json({ error: 'Original native inference current authority unavailable' });
    }
  });
  router.get('/resources', (_req, res) => {
    try {
      const owner = currentOwner();
      if (!owner?.resources) throw Error('Original native resource capability unavailable');
      res.json(owner.resources());
    } catch {
      res.status(503).json({ error: 'Original native resource observation unavailable' });
    }
  });
  router.get('/enrollments/:profileId', (req, res) => {
    try {
      res.json(currentOwner()!.enrollment(req.params.profileId));
    } catch {
      res.status(409).json({ error: 'Staging feature enrollment unavailable' });
    }
  });
  router.post('/plan', async (req, res) => {
    const input = planBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Bounded staging feature plan required' });
      return;
    }
    try {
      res.json(await currentOwner()!.plan(input.data.request, input.data.sourceCommit));
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
      res.json(
        await currentOwner()!.run(
          input.data.plan,
          input.data.token,
          captureCustodianRequestCurrent(req),
        ),
      );
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
