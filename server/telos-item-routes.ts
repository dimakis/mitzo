import { Router, type Request } from 'express';
import { TelosItemStore } from './telos-item-store.js';
import { TelosGetItemInput, TelosUpdateItemInput } from './telos-item-tools.js';

export function createTelosItemRouter(options: {
  dbPath(): string;
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
}) {
  const router = Router();
  for (const operation of ['get', 'update'] as const) {
    router.post(`/api/internal/telos/items/${operation}`, (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      if (!options.verifyInternal(req)) {
        res.status(401).json({ ok: false, error: 'Internal token required' });
        return;
      }
      const sessionId = options.sessionId(String(req.headers['x-client-id'] ?? ''));
      if (!sessionId) {
        res.status(409).json({ ok: false, error: 'Active Mitzo session required' });
        return;
      }
      const parsed = (operation === 'get' ? TelosGetItemInput : TelosUpdateItemInput).safeParse(
        req.body,
      );
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: 'Invalid Telos item input' });
        return;
      }
      let store: TelosItemStore | undefined;
      try {
        store = new TelosItemStore(options.dbPath());
        if (operation === 'get') res.json({ ok: true, item: store.read(parsed.data.itemId) });
        else
          res.json({
            ok: true,
            ...store.update(TelosUpdateItemInput.parse(parsed.data), sessionId),
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const status =
          message === 'Telos item not found'
            ? 404
            : [
                  'Telos item changed;',
                  'Unfinished milestones;',
                  'Update request identity reused',
                ].some((prefix) => message.startsWith(prefix))
              ? 409
              : 503;
        res
          .status(status)
          .json({ ok: false, error: status === 503 ? 'Telos item service unavailable' : message });
      } finally {
        store?.close();
      }
    });
  }
  return router;
}
