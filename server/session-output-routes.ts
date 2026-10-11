import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { SessionOutputRegisterInputSchema, type SessionOutputReference } from '@mitzo/protocol';
import type { SessionOutputReferences } from './session-output-references.js';

/** Selected reference identity, not an access grant or independently retained snapshot. */
export function outputContextPackageDigest(
  sessionId: string,
  output: SessionOutputReference,
): string {
  if (output.sessionId !== sessionId || output.source.sessionId !== sessionId)
    throw new Error('Output conversation mismatch');
  return createHash('sha256')
    .update(JSON.stringify([sessionId, output.outputId, output.revision, output.source.sha256]))
    .digest('hex');
}

const sourceConflicts = new Set([
  'Output request identity reused with different input',
  'Source message identity is ambiguous',
  'Source must be an exact finalized assistant message',
  'Source provenance is invalid',
  'Source seat attribution has no provenance',
  'Source exceeds bounded event limit',
  'Source block attribution changed',
  'Source message finalization is ambiguous',
  'Source must be one finalized text block',
  'Source must be one finalized nonempty text block',
  'Source text exceeds 256 KB',
  'Source content hash changed',
  'Source already registered with a different title',
  'Session output source is unavailable',
]);
function failure(res: Response, error: unknown) {
  if (error instanceof Error && error.message === 'Session output not found') {
    res.status(404).json({ error: 'Session output not found' });
  } else if (error instanceof Error && sourceConflicts.has(error.message)) {
    res.status(409).json({
      error:
        'Output source is unavailable or registration conflicts. Refresh the selected output before retrying.',
    });
  } else {
    res.status(503).json({ error: 'Session output service unavailable' });
  }
}

/** Mount behind operator authentication at /api/sessions/:id/outputs.
 * Authorization remains the existing private operator/session boundary. */
export function createSessionOutputRouter(options: {
  references: SessionOutputReferences;
  hasSession(sessionId: string): boolean;
}) {
  const router = Router({ mergeParams: true });
  router.use((req: Request, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (typeof req.params.id !== 'string' || !options.hasSession(req.params.id)) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      next();
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/', (req: Request, res) => {
    try {
      res.json(options.references.list(req.params.id as string));
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/', (req: Request, res) => {
    const input = SessionOutputRegisterInputSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid session output input' });
      return;
    }
    try {
      res.json({ output: options.references.register(req.params.id as string, input.data) });
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/:outputId', (req: Request, res) => {
    if (typeof req.params.outputId !== 'string' || !/^[a-f0-9-]{36}$/.test(req.params.outputId)) {
      res.status(404).json({ error: 'Session output not found' });
      return;
    }
    try {
      const selected = options.references.read(req.params.id as string, req.params.outputId);
      res.json({
        ...selected,
        contextPackageDigest: outputContextPackageDigest(req.params.id as string, selected.output),
      });
    } catch (error) {
      failure(res, error);
    }
  });
  return router;
}
