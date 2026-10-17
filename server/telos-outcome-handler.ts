import type { Request, RequestHandler } from 'express';

/** Retired creation transport. Internal tokens and generic tool grants do not
 * authorize a new source capture. Historical origin records remain retained. */
export function createTelosOutcomeHandler(options: {
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
  availableSource(id: string): boolean;
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
    res.status(403).json({
      ok: false,
      error:
        'Reviewed original source approval is required. Use the current Telos tool and its source review card.',
    });
  };
}
