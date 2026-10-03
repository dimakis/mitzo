import { createHash } from 'node:crypto';
import { Router, json, type Request } from 'express';
import { TelosArtifactStore, MAX_TELOS_ARTIFACT_BYTES } from './telos-artifact-store.js';
import {
  TelosSaveArtifactInput,
  TelosFindArtifactsInput,
  TelosReadArtifactInput,
} from './telos-artifact-tools.js';

// A UTF-8 control byte can become six JSON bytes (\\u0000); leave bounded metadata room.
export const telosArtifactSaveJson = json({ limit: 6 * MAX_TELOS_ARTIFACT_BYTES + 64 * 1024 });

export function createTelosArtifactRouter(options: {
  dbPath(): string;
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
  readFile(sessionId: string, path: string): Promise<{ path: string; bytes: Buffer }>;
}) {
  const router = Router();
  const errorStatus = (error: unknown) => {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number')
      return error.status;
    if (
      error instanceof Error &&
      ['Telos item not found', 'Artifact not found'].includes(error.message)
    )
      return 404;
    if (
      error instanceof Error &&
      error.message === 'Save request identity reused with different input'
    )
      return 409;
    if (error instanceof Error && error.message === 'Artifact exceeds 5 MB') return 413;
    return 503;
  };
  for (const operation of ['save', 'find', 'read'] as const) {
    router.post(`/api/internal/telos/artifacts/${operation}`, async (req, res) => {
      if (!options.verifyInternal(req)) {
        res.status(401).json({ ok: false, error: 'Internal token required' });
        return;
      }
      const sessionId = options.sessionId(String(req.headers['x-client-id'] ?? ''));
      if (!sessionId) {
        res.status(409).json({ ok: false, error: 'Active Mitzo session required' });
        return;
      }
      const schema = {
        save: TelosSaveArtifactInput,
        find: TelosFindArtifactsInput,
        read: TelosReadArtifactInput,
      }[operation];
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: 'Invalid Telos artifact input' });
        return;
      }
      let store: TelosArtifactStore | undefined;
      try {
        store = new TelosArtifactStore(options.dbPath());
        if (operation === 'save') {
          const input = TelosSaveArtifactInput.parse(parsed.data);
          const requestInputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
          const receipt = store.retryReceipt(sessionId, input.requestId, requestInputHash);
          if (receipt) {
            res.json({ ok: true, artifact: receipt });
            return;
          }
          const file =
            input.path !== undefined
              ? await options.readFile(sessionId, input.path)
              : { bytes: Buffer.from(input.content!, 'utf8'), path: undefined };
          const artifact = store.save({
            ...input,
            requestInputHash,
            bytes: file.bytes,
            sourcePath: file.path,
            sessionId,
          });
          res.json({ ok: true, artifact });
        } else if (operation === 'find') {
          res.json({ ok: true, artifacts: store.list(TelosFindArtifactsInput.parse(parsed.data)) });
        } else {
          const input = TelosReadArtifactInput.parse(parsed.data);
          const { bytes, ...artifact } = store.read(input.id, input.revision);
          const text = bytes.toString('utf8');
          const encoding = Buffer.from(text, 'utf8').equals(bytes) ? 'utf8' : 'base64';
          res.json({
            ok: true,
            artifact: { ...artifact, encoding, content: bytes.toString(encoding) },
          });
        }
      } catch (error) {
        const status = errorStatus(error);
        res.status(status).json({
          ok: false,
          error:
            status === 503
              ? 'Telos artifact service unavailable'
              : error instanceof Error
                ? error.message
                : 'Telos artifact request failed',
        });
      } finally {
        store?.close();
      }
    });
  }
  // Authenticated metadata browsing does not depend on an active agent session.
  router.get('/api/telos/items/:itemId/artifacts', (req, res) => {
    const input = TelosFindArtifactsInput.safeParse({ itemId: req.params.itemId, limit: 100 });
    if (!input.success) {
      res.status(400).json({ error: 'Invalid work identity' });
      return;
    }
    let store: TelosArtifactStore | undefined;
    try {
      store = new TelosArtifactStore(options.dbPath());
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ artifacts: store.list(input.data), limit: 100 });
    } catch {
      res.status(503).json({ error: 'Saved outputs unavailable' });
    } finally {
      store?.close();
    }
  });
  // Mounted after Mitzo's cookie/internal-token authentication. Always download, never execute HTML.
  router.get('/api/telos/artifacts/:id', (req, res) => {
    const input = TelosReadArtifactInput.safeParse({
      id: req.params.id,
      ...(req.query.revision !== undefined ? { revision: Number(req.query.revision) } : {}),
    });
    if (!input.success) {
      res.status(400).json({ error: 'Invalid artifact reference' });
      return;
    }
    let store: TelosArtifactStore | undefined;
    try {
      store = new TelosArtifactStore(options.dbPath());
      const artifact = store.read(input.data.id, input.data.revision);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Artifact-Sha256', artifact.sha256);
      res.send(artifact.bytes);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: 'Telos artifact unavailable' });
    } finally {
      store?.close();
    }
  });
  return router;
}
