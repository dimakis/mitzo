import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { MAX_SESSION_DOCUMENT_BYTES, SessionOutputSourceSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { discoverSessionDocuments, isDocumentPath } from './session-document-discovery.js';
import type { TelosArtifactMetadata } from './telos-artifact-store.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const path = z.string().min(1).max(4096).refine(isDocumentPath);
const fileSource = z.strictObject({
  kind: z.literal('file'),
  path,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const keepInput = z.strictObject({
  requestId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  source: z.union([fileSource, SessionOutputSourceSchema.extend({ kind: z.literal('draft') })]),
});
const conflict = () =>
  Object.assign(new Error('Document changed. Preview it again before keeping it.'), {
    status: 409,
  });
function failure(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const status =
    error instanceof Error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : message === 'Saved document not found'
        ? 404
        : message === 'Document save request conflicts'
          ? 409
          : 503;
  res.status(status).json({
    error:
      status === 409
        ? 'Document or save request changed. Refresh and retry.'
        : status === 404
          ? 'Saved document not found.'
          : 'Document unavailable. Your existing files and saved versions are unchanged.',
  });
}
function preview(bytes: Buffer, filename: string) {
  const text = bytes.toString('utf8');
  return /\.(md|markdown|txt|csv|tsv|json|ya?ml|svg|html?)$/i.test(filename) &&
    Buffer.from(text).equals(bytes)
    ? { content: text }
    : { content: null };
}
/** Authenticated human operations only: no model/account credentials, task creation or runtime recovery. */
export function createSessionDocumentRouter(options: {
  store: EventStore;
  readFile(sessionId: string, path: string): Promise<{ path: string; bytes: Buffer }>;
  listTelos(sessionId: string): { artifacts: TelosArtifactMetadata[]; hasMore: boolean };
}) {
  const { store } = options;
  const router = Router({ mergeParams: true });
  router.use((req: Request, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const session = store.getSession(req.params.id as string);
    if (!session || session.sessionType === 'symposium' || session.isHidden)
      return void res.status(404).json({ error: 'Conversation unavailable.' });
    next();
  });
  const current = (id: string) => {
    const meta = store.getSession(id);
    if (!meta || meta.isHidden || meta.sessionType === 'symposium') throw conflict();
    return {
      cwd: meta.cwd,
      account: meta.accountBinding,
      runtime: store.getSessionRuntimeBinding(id),
      workspace: meta.ordinaryWorkspaceId,
      repository: meta.repositoryWorkspaceId,
    };
  };
  const read = async (id: string, requested: string) => {
    const scope = current(id);
    const file = await options.readFile(id, requested);
    if (!isDeepStrictEqual(scope, current(id))) throw conflict();
    if (file.bytes.length > MAX_SESSION_DOCUMENT_BYTES)
      throw Object.assign(new Error('Too large'), { status: 413 });
    if (!isDocumentPath(file.path))
      throw Object.assign(new Error('Unsupported document'), { status: 403 });
    return file;
  };
  router.get('/', (req: Request, res) => {
    const id = req.params.id as string;
    try {
      let telos: TelosArtifactMetadata[] = [],
        telosError: string | undefined,
        telosHasMore = false;
      try {
        const result = options.listTelos(id);
        telos = result.artifacts;
        telosHasMore = result.hasMore;
      } catch {
        telosError = 'Saved Work documents could not be checked. Refresh to retry.';
      }
      res.json({
        saved: store.listSessionDocuments(id),
        workspace: discoverSessionDocuments(store, id),
        telos,
        telosError,
        telosHasMore,
        discoveryLimit: 100,
      });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/preview', async (req: Request, res) => {
    const input = z.strictObject({ path }).safeParse(req.body);
    if (!input.success)
      return void res.status(400).json({ error: 'Choose a supported document path.' });
    try {
      const file = await read(req.params.id as string, input.data.path);
      res.json({
        path: file.path,
        filename: basename(file.path),
        size: file.bytes.length,
        sha256: hash(file.bytes),
        ...preview(file.bytes, file.path),
      });
    } catch (error) {
      failure(res, error);
    }
  });
  router.post('/keep', async (req: Request, res) => {
    const parsed = keepInput.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid document selection.' });
    const input = parsed.data,
      id = req.params.id as string;
    try {
      const intent = JSON.stringify([input.title, input.source]);
      const prior = store.sessionDocumentReceipt(id, input.requestId, intent);
      if (prior) return void res.json({ document: prior });
      let bytes: Buffer, filename: string, sourcePath: string | null, sourceKey: string;
      if (input.source.kind === 'file') {
        const file = await read(id, input.source.path);
        if (hash(file.bytes) !== input.source.sha256) throw conflict();
        bytes = file.bytes;
        filename = basename(file.path);
        sourcePath = file.path;
        sourceKey = `file:${file.path}`;
      } else {
        const source = input.source;
        try {
          bytes = Buffer.from(store.readSessionDocumentDraft(id, source));
        } catch {
          throw conflict();
        }
        filename =
          [...input.title]
            .map((char) =>
              char === '/' || char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
                ? '-'
                : char,
            )
            .join('')
            .slice(0, 190) + '.md';
        sourcePath = null;
        sourceKey = `draft:${source.messageId}:${source.blockId}`;
      }
      current(id);
      res.json({
        document: store.keepSessionDocument(id, {
          ...input,
          intent,
          filename,
          sourcePath,
          sourceKey,
          bytes,
        }),
      });
    } catch (error) {
      failure(res, error);
    }
  });
  router.get('/saved/:documentId/versions', (req: Request, res) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .safeParse(req.params.documentId);
    const before =
      req.query.before === undefined
        ? undefined
        : z.coerce.number().int().positive().safe().safeParse(req.query.before);
    if (!id.success || (before && !before.success))
      return void res.status(400).json({ error: 'Invalid saved version.' });
    try {
      res.json({
        versions: store.sessionDocumentVersions(req.params.id as string, id.data, before?.data),
      });
    } catch (error) {
      failure(res, error);
    }
  });
  const saved = (req: Request, res: Response, download: boolean) => {
    const selection = z
      .object({
        id: z.string().regex(/^[a-f0-9]{32}$/),
        revision: z.coerce.number().int().positive().safe(),
      })
      .safeParse({ id: req.params.documentId, revision: req.query.revision });
    if (!selection.success)
      return void res.status(400).json({ error: 'Select an exact saved version.' });
    try {
      const { bytes, ...document } = store.readSessionDocument(
        req.params.id as string,
        selection.data.id,
        selection.data.revision,
      );
      if (download) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
        );
        res.send(bytes);
      } else res.json({ document, ...preview(bytes, document.filename) });
    } catch (error) {
      failure(res, error);
    }
  };
  router.get('/saved/:documentId/download', (req: Request, res) => saved(req, res, true));
  router.get('/saved/:documentId', (req: Request, res) => saved(req, res, false));
  return router;
}
