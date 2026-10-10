import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revokeAuthSession, type AuthSession } from '../auth.js';
import express from 'express';
import request from 'supertest';
import { AgentLibraryStore } from '../agent-library-store.js';
import { createAgentLibraryRouter } from '../agent-library-router.js';
import { selectCustodianOperation, custodianRoute } from '../symposium-custodian-protocol.js';
import { ContextPackStore } from '../context-pack-store.js';
import { createAcceptedContextPacks } from '../context-pack-runtime.js';

const definition = {
  name: 'Bob',
  descriptor: 'The architect',
  role: 'reviewer',
  instructions: 'Challenge assumptions.',
  expectedOutput: 'A decision brief',
  acceptanceCriteria: ['Use evidence'],
  modelPolicyRole: 'reviewer',
};
const stores: AgentLibraryStore[] = [];
const roots: string[] = [];
let login = 0;
function app(
  operator = true,
  options: Parameters<typeof createAgentLibraryRouter>[1] = {},
  auth: AuthSession = { id: `verified-login-${++login}`, expiresAt: Date.now() + 60000 },
) {
  const store = new AgentLibraryStore(':memory:');
  stores.push(store);
  const app = express();
  app.use(express.json());
  if (operator)
    app.use((_req, res, next) => {
      res.locals.authSession = auth;
      next();
    });
  app.use('/api/agent-library', createAgentLibraryRouter(store, options));
  return app;
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-context-preview-'));
  roots.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'AGENTS.md'), '# Rules\nKeep tasks safe.');
  writeFileSync(join(root, 'docs/design.md'), '# Design\n## Architecture\nUse immutable bundles.');
  return root;
}
const compiledDefinition = {
  ...definition,
  contextRecipe: {
    version: 1 as const,
    source: 'workspace' as const,
    files: ['docs/design.md'],
    tokenBudget: 1000,
    required: [],
    excluded: [],
  },
};
it('previews pinned Knowledge packs through the same source adapter as runtime startup', async () => {
  const contextPacks = new ContextPackStore(':memory:');
  try {
    const packDraft = contextPacks.create({
      version: 1,
      id: 'review',
      name: 'Review',
      description: '',
      tokenBudget: 1000,
      documents: [
        {
          path: 'review.md',
          revision: 'a'.repeat(40),
          mode: 'required',
          headings: [],
          priority: 100,
        },
      ],
      retrievalGuidance: '',
    });
    const pack = contextPacks.publish(packDraft.id, packDraft.version);
    const runtime = {
      contextPacks,
      sourceIdentity: 'github:owner/knowledge@main',
      source: {
        allowed: () => true,
        read: async (path: string, revision: string) => ({
          path,
          revision,
          content: '# Review\nAccepted shared review method.',
        }),
      },
    };
    const server = app(true, {
      contextPacks: async (signal) =>
        createAcceptedContextPacks(runtime, { assertCurrent: () => signal.throwIfAborted() }),
    });
    const response = await request(server)
      .post('/api/agent-library/preview')
      .send({
        definition: {
          ...definition,
          contextRecipe: {
            version: 2,
            source: 'packs',
            tokenBudget: 1000,
            packs: [{ id: pack.id, revision: pack.revision, hash: pack.hash }],
          },
        },
      })
      .expect(200);
    expect(response.body.previewScope).toBe('accepted-knowledge-packs');
    expect(response.body.assembledPrompt).toContain('Accepted shared review method.');
    expect(response.body.compiledContext.provenance.documents[0].storeId).toBe(
      runtime.sourceIdentity,
    );
  } finally {
    contextPacks.close();
  }
});
it('requires interactive operator authentication for reads and writes', async () => {
  const server = app(false);
  await request(server).get('/api/agent-library').expect(403);
  await request(server).post('/api/agent-library/drafts').send({}).expect(403);
});
it('saves a draft, publishes it, and exports its exact portable identity', async () => {
  const server = app();
  await request(server)
    .post('/api/agent-library/drafts')
    .send({
      profileId: 'bob',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'draft',
      definition,
    })
    .expect(200);
  const draftList = await request(server).get('/api/agent-library').expect(200);
  expect(draftList.body.versions).toEqual([]);
  await request(server)
    .post('/api/agent-library/publish')
    .send({ profileId: 'bob', expectedVersion: 1, idempotencyKey: 'publish' })
    .expect(200);
  const exported = await request(server).get('/api/agent-library/bob/1/export').expect(200);
  expect(exported.body.definition.descriptor).toBe('The architect');
  expect(exported.body).not.toHaveProperty('owner');
  const listed = await request(server).get('/api/agent-library').expect(200);
  expect(listed.body.drafts).toEqual([]);
  expect(listed.body.versions).toHaveLength(1);
});
it('returns a conflict for stale drafts and rejects caller-supplied ownership', async () => {
  const server = app();
  const body = {
    profileId: 'bob',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition,
  };
  await request(server).post('/api/agent-library/drafts').send(body).expect(200);
  await request(server)
    .post('/api/agent-library/drafts')
    .send({ ...body, idempotencyKey: 'stale' })
    .expect(409);
  await request(server)
    .post('/api/agent-library/drafts')
    .send({ ...body, owner: 'other' })
    .expect(400);
});
it('previews portable guidance and reports context as unresolved without model calls', async () => {
  const response = await request(app())
    .post('/api/agent-library/preview')
    .send({ definition })
    .expect(200);
  expect(response.body.profilePrompt).toContain('Bob · The architect');
  expect(response.body.profilePrompt).toContain('Challenge assumptions.');
  expect(response.body.contextResolved).toBe(false);
});
it('routes Library operations through the retained custodian rather than a second catalog owner', () => {
  for (const [method, path] of [
    ['GET', '/api/agent-library'],
    ['POST', '/api/agent-library/drafts'],
    ['POST', '/api/agent-library/publish'],
    ['POST', '/api/agent-library/preview'],
    ['POST', '/api/agent-library/import'],
    ['GET', '/api/agent-library/bob/1/export'],
  ]) {
    const selected = selectCustodianOperation(method, path);
    expect(selected).not.toBeNull();
    expect(custodianRoute(selected!)).toEqual({ method, path });
  }
});

it('compiles a context preview in the server-selected workspace and returns auditable sources without creating a session', async () => {
  const root = workspace();
  const response = await request(app(true, { workspaceRoot: root }))
    .post('/api/agent-library/preview')
    .send({ definition: compiledDefinition })
    .expect(200);
  expect(response.body.contextResolved).toBe(true);
  expect(response.body.assembledPrompt).toContain('Bob · The architect');
  expect(response.body.assembledPrompt).toContain('Use immutable bundles.');
  expect(
    response.body.compiledContext.context.sources.map((source: { path: string }) => source.path),
  ).toEqual(['AGENTS.md', 'docs/design.md']);
  expect(response.body.compiledContext.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.previewScope).toBe('configured-workspace');
});
it('rejects caller-selected host roots, unavailable documents, and attempts to exclude canonical instructions', async () => {
  const root = workspace();
  const server = app(true, { workspaceRoot: root });
  await request(server)
    .post('/api/agent-library/preview')
    .send({ definition: compiledDefinition, workspaceRoot: root })
    .expect(400);
  for (const contextRecipe of [
    { ...compiledDefinition.contextRecipe, files: ['missing.md'] },
    { ...compiledDefinition.contextRecipe, excluded: [['AGENTS.md']] },
  ]) {
    const response = await request(server)
      .post('/api/agent-library/preview')
      .send({ definition: { ...compiledDefinition, contextRecipe } })
      .expect(400);
    expect(response.body.contextResolved).not.toBe(true);
  }
});
it('compiles configured presets without fetching any provider or accepting a caller service URL', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        agent: 'architect',
        boot: {
          content: '# Compiled preset',
          tokens: 5,
          tokenBudget: 1000,
          sources: ['Architecture.md'],
        },
      }),
    ),
  );
  const server = app(true, { contexginUrl: 'http://configured.test:4195' });
  const preset = {
    ...definition,
    contextRecipe: { version: 1, source: 'contexgin', agentName: 'architect' },
  };
  const response = await request(server)
    .post('/api/agent-library/preview')
    .send({ definition: preset })
    .expect(200);
  expect(response.body.assembledPrompt).toContain('Compiled preset');
  expect(response.body.previewScope).toBe('contexgin-preset');
  expect(fetcher).toHaveBeenCalledWith(
    'http://configured.test:4195/api/agents/architect/context',
    expect.anything(),
  );
  await request(server)
    .post('/api/agent-library/preview')
    .send({ definition: preset, contexginUrl: 'http://caller.test' })
    .expect(400);
});
it('refuses a compiled preview whose operator session is revoked during compilation', async () => {
  const auth = { id: 'revoked-preview-login', expiresAt: Date.now() + 60000 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    revokeAuthSession(auth);
    return new Response(
      JSON.stringify({
        agent: 'architect',
        boot: { content: '# Revoked preset', tokens: 5, tokenBudget: 1000, sources: [] },
      }),
    );
  });
  const response = await request(app(true, {}, auth))
    .post('/api/agent-library/preview')
    .send({
      definition: {
        ...definition,
        contextRecipe: { version: 1, source: 'contexgin', agentName: 'architect' },
      },
    })
    .expect(403);
  expect(response.body.compiledContext).toBeUndefined();
});
