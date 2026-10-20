import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { TelosUserUploadInput, validateUserUpload } from './telos-user-upload.js';
import { Router, json, type Request, type RequestHandler, type Response } from 'express';
import {
  TelosArtifactStore,
  MAX_TELOS_ARTIFACT_BYTES,
  describeTelosArtifactDocument,
  type TelosArtifactMetadata,
} from './telos-artifact-store.js';
import {
  TelosSaveArtifactInput,
  TelosFindArtifactsInput,
  TelosReadArtifactInput,
} from './telos-artifact-tools.js';

// A UTF-8 control byte can become six JSON bytes (\\u0000); leave bounded metadata room.
export const telosArtifactSaveJson = json({ limit: 6 * MAX_TELOS_ARTIFACT_BYTES + 64 * 1024 });

export function createTelosArtifactRouter(options: {
  dbPath(): string;
  operatorAuth?: RequestHandler;
  verifyInternal(req: Request): boolean;
  sessionId(clientId: string): string | undefined;
  readFile(sessionId: string, path: string): Promise<{ path: string; bytes: Buffer }>;
}) {
  const router = Router();
  const documentId = z.string().regex(/^[a-f0-9]{32}$/);
  const documentRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  const editDocumentInput = z
    .object({
      expectedRevision: documentRevision,
      content: z.string(),
      requestId: z.string().min(1).max(200),
    })
    .strict();
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
  const assertResponseEligibility = (
    store: TelosArtifactStore,
    metadata: TelosArtifactMetadata,
  ) => {
    // Scoped source packets keep their existing interactive operator read path.
    if (metadata.sourceKind !== 'source_capture' && !store.userUploadAllowed(metadata.itemId))
      throw Object.assign(new Error('Saved artifact unavailable'), { status: 403 });
  };
  const readResponseArtifact = (store: TelosArtifactStore, expected: TelosArtifactMetadata) => {
    assertResponseEligibility(store, expected);
    const current = store.readBoundedRevision(
      expected.id,
      expected.revision,
      MAX_TELOS_ARTIFACT_BYTES,
    );
    const { bytes, ...metadata } = current;
    if (
      !isDeepStrictEqual(metadata, expected) ||
      createHash('sha256').update(bytes).digest('hex') !== expected.sha256
    )
      throw new Error('Saved artifact custody changed');
    assertResponseEligibility(store, metadata);
    return current;
  };
  const authorizeSourceRead = async (req: Request, res: Response) => {
    let authorized = false;
    if (options.operatorAuth)
      await options.operatorAuth(req, res, (error) => {
        if (error) throw error;
        authorized =
          typeof res.locals.authSession?.id === 'string' && !!res.locals.authSession.id.trim();
      });
    if (!authorized && !res.headersSent)
      res.status(403).json({ error: 'Interactive operator authentication is required' });
    return authorized;
  };
  router.get(
    '/api/telos/artifacts/:id/versions',
    options.operatorAuth ??
      ((_req, res) => {
        res.status(403).json({ error: 'Interactive operator authentication is required' });
      }),
    (req, res) => {
      if (typeof res.locals.authSession?.id !== 'string' || !res.locals.authSession.id.trim()) {
        res.status(403).json({ error: 'Interactive operator authentication is required' });
        return;
      }
      const id = documentId.safeParse(req.params.id);
      const query = z
        .strictObject({
          beforeRevision: z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .transform(Number)
            .pipe(documentRevision)
            .optional(),
          limit: z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .transform(Number)
            .pipe(z.number().int().min(1).max(50))
            .optional(),
        })
        .safeParse(req.query);
      if (!id.success || !query.success) {
        res.status(400).json({ error: 'Invalid artifact history reference' });
        return;
      }
      let store: TelosArtifactStore | undefined;
      try {
        store = new TelosArtifactStore(options.dbPath());
        const page = store.revisionPage(id.data, query.data);
        // Authentication may have awaited; current item policy also remains a final local fence.
        if (
          page.artifacts.some(
            (row) => row.sourceKind === 'source_capture' || !store!.userUploadAllowed(row.itemId),
          )
        ) {
          res.status(403).json({ error: 'Saved artifact history unavailable' });
          return;
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(page);
      } catch (error) {
        res.status(errorStatus(error)).json({ error: 'Saved artifact history unavailable' });
      } finally {
        store?.close();
      }
    },
  );
  router.get('/api/telos/artifacts/:id/document', async (req, res) => {
    const id = documentId.safeParse(req.params.id);
    const revision =
      req.query.revision === undefined
        ? undefined
        : documentRevision.safeParse(
            typeof req.query.revision === 'string' ? Number(req.query.revision) : NaN,
          );
    if (!id.success || (revision && !revision.success)) {
      res.status(400).json({ error: 'Invalid artifact reference' });
      return;
    }
    let store: TelosArtifactStore | undefined;
    try {
      store = new TelosArtifactStore(options.dbPath());
      const metadata = revision
        ? store.metadataForRevision(id.data, revision.data!)
        : store.latestMetadata(id.data);
      assertResponseEligibility(store, metadata);
      if (metadata.sourceKind === 'source_capture' && !(await authorizeSourceRead(req, res)))
        return;
      const artifact = readResponseArtifact(store, metadata);
      const document = describeTelosArtifactDocument(
        artifact,
        artifact.sourceKind !== 'source_capture' && store.userUploadAllowed(artifact.itemId),
      );
      assertResponseEligibility(store, metadata);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(document);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: 'Telos document unavailable' });
    } finally {
      store?.close();
    }
  });
  router.put(
    '/api/telos/artifacts/:id/document',
    options.operatorAuth ??
      ((_req, res) => {
        res.status(403).json({ error: 'Interactive operator authentication is required' });
      }),
    (req, res) => {
      const operatorId = res.locals.authSession?.id;
      if (typeof operatorId !== 'string' || !operatorId) {
        res.status(403).json({ error: 'Interactive operator authentication is required' });
        return;
      }
      const id = documentId.safeParse(req.params.id);
      const input = editDocumentInput.safeParse(req.body);
      if (!id.success || !input.success) {
        res.status(400).json({ error: 'Invalid document edit' });
        return;
      }
      if (Buffer.byteLength(input.data.content) > MAX_TELOS_ARTIFACT_BYTES) {
        res.status(413).json({ error: 'Artifact exceeds 5 MB' });
        return;
      }
      let store: TelosArtifactStore | undefined;
      try {
        store = new TelosArtifactStore(options.dbPath());
        const artifact = store.editDocument({ ...input.data, id: id.data, operatorId });
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ok: true, artifact });
      } catch (error) {
        const status = errorStatus(error);
        res.status(status).json({
          error:
            status === 503
              ? 'Save unavailable; your draft is preserved'
              : error instanceof Error
                ? error.message
                : 'Save failed',
        });
      } finally {
        store?.close();
      }
    },
  );
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
          res.json({
            ok: true,
            artifacts: store.list({
              ...TelosFindArtifactsInput.parse(parsed.data),
              excludeSourceCaptures: true,
            }),
          });
        } else {
          const input = TelosReadArtifactInput.parse(parsed.data);
          const { bytes, ...artifact } = store.read(input.id, input.revision);
          if (artifact.sourceKind === 'source_capture') {
            res
              .status(403)
              .json({ ok: false, error: 'Reviewed source requires scoped host authority' });
            return;
          }
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
  // Interactive uploads are user evidence, never attributed to an active model session.
  router.post(
    '/api/telos/items/:itemId/artifacts/upload',
    options.operatorAuth ??
      ((_req, res) => {
        res.status(403).json({ error: 'Interactive operator authentication is required' });
      }),
    (req, res) => {
      const operatorId = res.locals.authSession?.id;
      if (typeof operatorId !== 'string' || !operatorId) {
        res.status(403).json({ error: 'Interactive operator authentication is required' });
        return;
      }
      const parsed = TelosUserUploadInput.safeParse(req.body);
      const item = TelosFindArtifactsInput.safeParse({ itemId: req.params.itemId });
      if (!parsed.success || !item.success) {
        res.status(400).json({ error: 'Invalid upload input' });
        return;
      }
      const { base64, ...input } = parsed.data;
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > MAX_TELOS_ARTIFACT_BYTES) {
        res.status(413).json({ error: 'Artifact exceeds 5 MB' });
        return;
      }
      if (bytes.toString('base64') !== base64 || !validateUserUpload(input.filename, bytes)) {
        res.status(400).json({ error: 'Unsupported file type, encoding or file signature' });
        return;
      }
      let store: TelosArtifactStore | undefined;
      try {
        store = new TelosArtifactStore(options.dbPath());
        if (!store.userUploadAllowed(item.data.itemId!)) {
          res.status(403).json({
            error:
              'LifeOps documents require private case storage; shared output uploads are unavailable.',
          });
          return;
        }
        const artifact = store.save({
          ...input,
          itemId: item.data.itemId!,
          bytes,
          sessionId: `user-upload:${operatorId}`,
          requestInputHash: createHash('sha256')
            .update(JSON.stringify([item.data.itemId, parsed.data]))
            .digest('hex'),
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ ok: true, artifact });
      } catch (error) {
        const status = errorStatus(error);
        res.status(status).json({
          error:
            status === 503
              ? 'Upload unavailable; your file is preserved'
              : error instanceof Error
                ? error.message
                : 'Upload failed',
        });
      } finally {
        store?.close();
      }
    },
  );
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
      res.json({
        artifacts: store.list({ ...input.data, excludeSourceCaptures: true }),
        limit: 100,
      });
    } catch {
      res.status(503).json({ error: 'Saved outputs unavailable' });
    } finally {
      store?.close();
    }
  });
  // Mounted after Mitzo's cookie/internal-token authentication. Always download, never execute HTML.
  router.get('/api/telos/artifacts/:id', async (req, res) => {
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
      const metadata =
        input.data.revision === undefined
          ? store.latestMetadata(input.data.id)
          : store.metadataForRevision(input.data.id, input.data.revision);
      assertResponseEligibility(store, metadata);
      if (metadata.sourceKind === 'source_capture' && !(await authorizeSourceRead(req, res)))
        return;
      const artifact = readResponseArtifact(store, metadata);
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
