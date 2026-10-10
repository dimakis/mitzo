import express from 'express';
import { parseMarkdown } from 'contexgin';
import { z } from 'zod';
import {
  ContextPackDefinitionSchema,
  ContextPackIdSchema,
  type ContextPackDefinition,
} from '@mitzo/protocol';
import { registerAuthSession, type AuthSession } from './auth.js';
import { requireSameOriginJson } from './connections-router.js';
import { safeKnowledgePath } from './knowledge-library-source.js';
import {
  ContextPackConflict,
  ContextPackMissing,
  type ContextPackStore,
} from './context-pack-store.js';

export interface ContextPackImpact {
  profileId: string;
  name: string;
  revision: number;
  packRevision: number;
}
export interface ContextPackDependencies {
  store: ContextPackStore;
  source: {
    read(path: string, revision: string, signal?: AbortSignal): Promise<{ content: string }>;
  };
  impact?(packId: string): Promise<ContextPackImpact[]>;
  preview?(definition: ContextPackDefinition, signal: AbortSignal): Promise<unknown>;
}
const versionBody = z.strictObject({ version: z.number().int().positive() });
const draftId = z.string().uuid();
const createBody = z.strictObject({
  definition: ContextPackDefinitionSchema,
  requestId: z.string().uuid().optional(),
});
const saveBody = createBody.extend({ version: z.number().int().positive() });

/** Match the exact pinned compiler grammar; portable selectors use heading ancestry. */
function headingPaths(content: string) {
  const tree = parseMarkdown(content);
  const paths: string[][] = [];
  const visit = (heading: (typeof tree)[number], parents: string[]) => {
    const path = [...parents, heading.title];
    paths.push(path);
    heading.children.forEach((child) => visit(child, path));
  };
  tree.forEach((heading) => visit(heading, []));
  return paths;
}
export async function validateContextPackSources(
  definition: ContextPackDefinition,
  source: ContextPackDependencies['source'],
  signal: AbortSignal,
) {
  const issues: string[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const doc of definition.documents) {
    signal.throwIfAborted();
    if (!safeKnowledgePath(doc.path)) throw new Error('Document is outside Knowledge scopes');
    const result = await source.read(doc.path, doc.revision, signal);
    signal.throwIfAborted();
    const bytes = Buffer.byteLength(result.content);
    const identity = `${doc.path}:${doc.revision}`;
    if (!seen.has(identity)) {
      totalBytes += bytes;
      seen.add(identity);
    }
    if (bytes > 64 * 1024 || totalBytes > 1024 * 1024 || result.content.includes('\0'))
      throw new Error('Knowledge document exceeds supported limits');
    const paths = headingPaths(result.content);
    for (const selector of doc.headings) {
      const matches = paths.filter(
        (path) =>
          path.length === selector.length &&
          selector.every((part, index) => part.toLowerCase() === path[index]?.toLowerCase()),
      );
      if (matches.length !== 1)
        issues.push(
          `${doc.path}: ${selector.join(' / ')} ${matches.length ? 'is ambiguous' : 'was not found'}`,
        );
    }
  }
  return issues;
}
class AuthorityExpired extends Error {}
/** Browser operator only; no caller-selected source directory, credentials or accepted ref. */
export function createContextPackRouter(load: () => Promise<ContextPackDependencies | undefined>) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const auth = res.locals.authSession as AuthSession | undefined;
    if (!auth || auth.expiresAt <= Date.now())
      return res.status(401).json({ error: 'Interactive operator authentication required' });
    return req.method === 'GET' ? next() : requireSameOriginJson(req, res, next);
  });
  function route(
    work: (
      req: express.Request,
      res: express.Response,
      runtime: ContextPackDependencies,
      signal: AbortSignal,
      assert: () => void,
    ) => Promise<unknown>,
  ): express.RequestHandler {
    return async (req, res) => {
      const auth = res.locals.authSession as AuthSession;
      const controller = new AbortController();
      const unregister = registerAuthSession(auth, () => controller.abort());
      const assert = () => {
        if (controller.signal.aborted || auth.expiresAt <= Date.now()) throw new AuthorityExpired();
      };
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(120000, Math.max(0, auth.expiresAt - Date.now())),
      );
      const abort = () => controller.abort();
      req.once('aborted', abort);
      try {
        assert();
        const runtime = await load();
        assert();
        if (!runtime) return res.status(503).json({ error: 'Knowledge Library is not configured' });
        return await work(req, res, runtime, controller.signal, assert);
      } catch (error) {
        if (error instanceof AuthorityExpired || controller.signal.aborted)
          return res.status(403).json({ error: 'Operator authorization expired or revoked' });
        if (error instanceof ContextPackMissing)
          return res.status(404).json({ error: error.message });
        if (error instanceof ContextPackConflict)
          return res.status(409).json({ error: error.message });
        if (error instanceof z.ZodError)
          return res.status(400).json({ error: 'Invalid context pack request' });
        return res
          .status(422)
          .json({ error: 'Context pack could not be validated. The saved draft is retained.' });
      } finally {
        clearTimeout(timer);
        unregister();
        req.off('aborted', abort);
      }
    };
  }
  router.get(
    '/',
    route(async (_req, res, runtime) => res.json(runtime.store.list())),
  );
  router.get(
    '/:id/revisions',
    route(async (req, res, runtime) =>
      res.json({ revisions: runtime.store.revisions(ContextPackIdSchema.parse(req.params.id)) }),
    ),
  );
  router.get(
    '/:id/revisions/:revision',
    route(async (req, res, runtime) =>
      res.json({
        pack: runtime.store.getRevision(
          ContextPackIdSchema.parse(req.params.id),
          z.coerce.number().int().positive().parse(req.params.revision),
        ),
      }),
    ),
  );
  router.get(
    '/:id/impact',
    route(async (req, res, runtime, _signal, assert) => {
      const id = ContextPackIdSchema.parse(req.params.id);
      if (!runtime.impact)
        return res.status(503).json({ error: 'Profile impact inspection is unavailable' });
      const profiles = await runtime.impact(id);
      assert();
      return res.json({ profiles });
    }),
  );
  router.post(
    '/drafts',
    route(async (req, res, runtime, _signal, assert) => {
      const body = createBody.parse(req.body);
      assert();
      return res.status(201).json({ draft: runtime.store.create(body.definition, body.requestId) });
    }),
  );
  router.get(
    '/drafts/:id',
    route(async (req, res, runtime) =>
      res.json({ draft: runtime.store.getDraft(draftId.parse(req.params.id)) }),
    ),
  );
  router.put(
    '/drafts/:id',
    route(async (req, res, runtime, _signal, assert) => {
      const body = saveBody.parse(req.body);
      assert();
      return res.json({
        draft: runtime.store.save(
          draftId.parse(req.params.id),
          body.version,
          body.definition,
          body.requestId,
        ),
      });
    }),
  );
  for (const action of ['validate', 'preview', 'publish'] as const) {
    router.post(
      `/drafts/:id/${action}`,
      route(async (req, res, runtime, signal, assert) => {
        const body = versionBody.parse(req.body);
        const id = draftId.parse(req.params.id);
        const draft = runtime.store.getDraft(id);
        if (draft.version !== body.version)
          throw new ContextPackConflict('Draft changed. Reload before continuing.');
        const issues = await validateContextPackSources(draft.definition, runtime.source, signal);
        assert();
        if (runtime.store.getDraft(id).version !== draft.version)
          throw new ContextPackConflict(
            'Draft changed during validation. Reload before continuing.',
          );
        if (action === 'validate') return res.json({ issues });
        if (issues.length)
          return res
            .status(422)
            .json({ error: 'Resolve document selectors before continuing', issues });
        if (!runtime.preview)
          return res.status(503).json({ error: 'Context compilation preview is unavailable' });
        const compiledContext = await runtime.preview(draft.definition, signal);
        assert();
        if (runtime.store.getDraft(id).version !== draft.version)
          throw new ContextPackConflict('Draft changed during preview. Reload before continuing.');
        if (action === 'preview') return res.json({ compiledContext });
        assert();
        const pack = runtime.store.publish(id, body.version);
        return res.status(201).json({ pack, draft: runtime.store.getDraft(id) });
      }),
    );
  }
  return router;
}
