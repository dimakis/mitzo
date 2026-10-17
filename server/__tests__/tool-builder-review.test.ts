import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createToolBuilderRouter } from '../tool-builder-router.js';
import { revokeAuthSession } from '../auth.js';
import { CustomToolRegistry, type InstalledCustomTool } from '../custom-tool-registry.js';
import { ToolBuilderStore } from '../tool-builder-store.js';
import {
  CustomToolDraftInputSchema,
  toolBuilderContractDigest,
  toolBuilderSourceDigest,
} from '../tool-builder.js';

const id = 'c2f63831-e4bc-46c2-ab36-7b7850ad501a';
const input = z.object({ text: z.string() }).strict();
const output = z.object({ length: z.number().int() }).strict();
function fixture() {
  const contract = CustomToolDraftInputSchema.parse({
    name: 'Text length',
    description: 'Count text characters',
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(input))),
    outputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(output))),
    examples: [{ input: { text: 'abc' }, expected: { length: 3 } }],
    permissions: { behavior: 'read', requiredConnections: [] },
    compatibility: { routes: ['local-api'] },
    testProfile: 'unit',
    files: [
      {
        path: 'src/index.mjs',
        content: 'export const runTool = ({text}) => ({length: text.length});\n',
      },
      {
        path: 'test/index.test.mjs',
        content: 'import {test} from "node:test"; test("length", () => {});\n',
      },
    ],
  });
  const sourceDigest = toolBuilderSourceDigest(contract.files);
  const contractDigest = toolBuilderContractDigest(contract);
  const draft = {
    ...contract,
    id,
    version: 1,
    status: 'unpublished' as const,
    workspaceId: 'workspace',
    sourceDigest,
    contractDigest,
    tests: {
      passed: true as const,
      complete: true as const,
      summary: 'Unit tests and examples passed',
      evidenceKind: 'trusted-executor' as const,
      sourceDigest,
      contractDigest,
      examples: [{ ...contract.examples[0], actual: { length: 3 } }],
    },
  };
  const qualify = vi.fn(async (_signal: AbortSignal) => {});
  const execute = vi.fn(async (value: Record<string, unknown>) => ({
    length: String(value.text).length,
  }));
  const sourceFiles = Object.fromEntries(
    contract.files.map((file) => [file.path, `../custom-tools/${id}/${file.path}`]),
  );
  const entry: InstalledCustomTool = {
    id: `custom:${id}`,
    version: 1,
    contractDigest,
    sourceFiles,
    executorSource: sourceFiles['src/index.mjs'],
    qualifierSource: sourceFiles['test/index.test.mjs'],
    qualify,
    input,
    output,
    execute,
  };
  let state = {
    entries: [entry],
    artifacts: Object.fromEntries(
      contract.files.map((file) => [
        sourceFiles[file.path],
        createHash('sha256').update(file.content).digest('hex'),
      ]),
    ),
    revision: 'fixture-v1',
  };
  const registry = new CustomToolRegistry(() => state);
  const store = new ToolBuilderStore(':memory:', registry);
  return {
    draft,
    entry,
    registry,
    store,
    execute,
    qualify,
    drift: () => {
      state = { ...state, revision: 'fixture-v2' };
    },
  };
}

it('keeps a reviewed draft private until explicit publication creates an exact catalog reference', async () => {
  const f = fixture();
  try {
    f.store.save('user', 'builder-session', 'call-1', f.draft, 0);
    expect(f.store.listTools('user')).toEqual([]);
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow();
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow();
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', contractDigest: f.draft.contractDigest, feedback: '' },
      'authenticated-operator',
    );
    expect(f.store.listTools('user')).toEqual([]);
    const published = await f.store.publish('user', id, 1, f.draft.contractDigest);
    expect(await f.store.publish('user', id, 1, f.draft.contractDigest)).toEqual(published);
    expect(f.store.listTools('user')).toEqual([published.entry]);
    expect(f.store.resolve('user', published.reference)).toEqual(published);
    f.store.save('user', 'builder-session', 'new-version', { ...f.draft, version: 2 }, 1);
    expect(f.store.read('user', id, 1)?.status).toBe('accepted');
    expect(f.store.resolve('user', published.reference)).toEqual(published);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(() => f.store.resolve('other-owner', published.reference)).toThrow();
    expect(() =>
      f.store.resolve('user', {
        ...published.reference,
        revision: 'f90ece17-2e73-4533-ab4e-3507c03a96fd',
      }),
    ).toThrow();
  } finally {
    f.store.close();
  }
});

it('preserves rejected feedback and accepted versions across revisions and exact retries', async () => {
  const f = fixture();
  try {
    const first = f.store.save('user', 'builder-session', 'call-1', f.draft, 0);
    expect(f.store.save('user', 'builder-session', 'call-1', f.draft, 0)).toEqual(first);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    f.store.review(
      'user',
      id,
      1,
      { decision: 'rejected', feedback: 'Cover Unicode', contractDigest: f.draft.contractDigest },
      'operator',
    );
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow();
    const next = { ...f.draft, version: 2 };
    f.store.save('user', 'builder-session', 'call-2', next, 1);
    expect(f.store.read('user', id, 1)?.review?.feedback).toBe('Cover Unicode');
    expect(f.store.read('user', id, 2)?.status).toBe('unpublished');
    expect(() =>
      f.store.save('user', 'other-session', 'call-3', { ...next, version: 3 }, 2),
    ).toThrow();
    expect(() => f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest)).toThrow(
      'version',
    );
    expect(() => f.store.save('user', 'builder-session', 'call-4', next, 1)).toThrow('version');
  } finally {
    f.store.close();
  }
});

it('blocks forged evidence, cancellation, unavailable source, write grants and source closure drift', async () => {
  const f = fixture();
  try {
    expect(() =>
      f.store.save(
        'user',
        'builder-session',
        'failed',
        { ...f.draft, tests: { ...f.draft.tests, passed: false } },
        0,
      ),
    ).toThrow();
    expect(() =>
      f.store.save(
        'user',
        'builder-session',
        'forged',
        { ...f.draft, permissions: { behavior: 'write', requiredConnections: [] } },
        0,
      ),
    ).toThrow();
    f.store.save('user', 'builder-session', 'call-1', f.draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    expect(() =>
      f.store.review(
        'user',
        id,
        1,
        { decision: 'accepted', feedback: '', contractDigest: 'e'.repeat(64) },
        'operator',
      ),
    ).toThrow();
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
      'operator',
    );
    const publication = await f.store.publish('user', id, 1, f.draft.contractDigest);
    f.drift();
    expect(() => f.store.resolve('user', publication.reference)).toThrow('changed');
    expect(f.store.listTools('user')[0].routes).toEqual([]);
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow();
    const empty = new CustomToolRegistry(() => ({ entries: [], artifacts: {}, revision: 'empty' }));
    expect(() => empty.bind(f.draft)).toThrow('installed');
    expect(() =>
      f.registry.bind({ ...f.draft, permissions: { behavior: 'write', requiredConnections: [] } }),
    ).toThrow();
  } finally {
    f.store.close();
  }
  const cancelled = fixture();
  try {
    cancelled.store.save('user', 'builder-session', 'call-1', cancelled.draft, 0);
    cancelled.store.cancel('user', id, 1);
    expect(() =>
      cancelled.store.submit('user', 'builder-session', id, 1, cancelled.draft.contractDigest),
    ).toThrow();
    await expect(
      cancelled.store.publish('user', id, 1, cancelled.draft.contractDigest),
    ).rejects.toThrow();
  } finally {
    cancelled.store.close();
  }
});

it('captures one registry source snapshot when selecting an implementation', async () => {
  const f = fixture();
  try {
    const binding = f.registry.bind(f.draft);
    const artifacts = Object.fromEntries(
      f.draft.files.map((file) => [
        f.entry.sourceFiles[file.path],
        createHash('sha256').update(file.content).digest('hex'),
      ]),
    );
    const good = { entries: [f.entry], artifacts, revision: 'fixture-v1' };
    const replacement = { ...good, entries: [{ ...f.entry, execute: vi.fn() }] };
    let calls = 0;
    const registry = new CustomToolRegistry(() => (++calls === 1 ? good : replacement));
    expect(registry.implementation(f.draft, binding).execute).toBe(f.execute);
    expect(calls).toBe(1);
  } finally {
    f.store.close();
  }
});

it('requires every draft source file and the executing module to belong to the reviewed closure', async () => {
  const f = fixture();
  try {
    for (const changes of [
      { sourceFiles: {} },
      { executorSource: '../unreviewed.ts' },
      { contractDigest: 'e'.repeat(64) },
    ]) {
      const registry = new CustomToolRegistry(() => ({
        entries: [{ ...f.entry, ...changes }],
        artifacts: {},
        revision: 'test',
      }));
      expect(() => registry.bind(f.draft)).toThrow();
    }
  } finally {
    f.store.close();
  }
});

it('requires independent installed-source qualification even when candidate code reported success', async () => {
  const f = fixture();
  try {
    const draft = { ...f.draft, tests: { ...f.draft.tests, evidenceKind: 'candidate-report' } };
    f.store.save('user', 'builder-session', 'candidate-report', draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
      'operator',
    );
    f.execute.mockImplementation(async () => {
      throw Error('Real implementation fails');
    });
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow();
    expect(f.store.listTools('user')).toEqual([]);
    expect(f.qualify).toHaveBeenCalledOnce();
  } finally {
    f.store.close();
  }
});

it('revalidates schemas in persisted evidence independently of the development executor', () => {
  const f = fixture();
  try {
    const contract = {
      ...f.draft,
      examples: [{ input: { text: 42 }, expected: { length: 'three' } }],
    };
    const contractDigest = toolBuilderContractDigest(contract);
    const forged = {
      ...contract,
      contractDigest,
      tests: {
        ...f.draft.tests,
        contractDigest,
        examples: [{ ...contract.examples[0], actual: { length: 'three' } }],
      },
    };
    expect(() => f.store.save('user', 'builder-session', 'forged', forged, 0)).toThrow(/schema/);
  } finally {
    f.store.close();
  }
});

it('cannot publish after approval authority or cancellation changes during trusted qualification', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    f.store.save('user', 'builder-session', 'call', f.draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
      'operator',
    );
    f.qualify.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      f.store.publish('user', id, 1, f.draft.contractDigest, {
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      }),
    ).rejects.toThrow();
    expect(f.store.listTools('user')).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});

it('prevents an older qualification from publishing after a newer attempt fails', async () => {
  const f = fixture();
  let finish!: () => void;
  try {
    f.store.save('user', 'builder-session', 'call', f.draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
      'operator',
    );
    f.qualify.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.qualify.mockImplementationOnce(async () => {
      throw Error('Trusted tests failed');
    });
    const older = f.store.publish('user', id, 1, f.draft.contractDigest).catch((error) => error);
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow(
      'Trusted tests failed',
    );
    finish();
    expect(await older).toBeInstanceOf(Error);
    expect(f.store.listTools('user')).toEqual([]);
  } finally {
    f.store.close();
  }
});

it('blocks publication when source changes during independent qualification', async () => {
  const f = fixture();
  try {
    f.store.save('user', 'builder-session', 'call', f.draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
      'operator',
    );
    f.qualify.mockImplementationOnce(async () => {
      f.drift();
    });
    await expect(f.store.publish('user', id, 1, f.draft.contractDigest)).rejects.toThrow('changed');
    expect(f.store.listTools('user')).toEqual([]);
  } finally {
    f.store.close();
  }
});

it('revokes awaited operator publication without creating a receipt', async () => {
  const f = fixture();
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = auth;
    next();
  });
  app.use(
    '/builder',
    createToolBuilderRouter(() => f.store),
  );
  try {
    f.store.save('user', 'builder-session', 'call', f.draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    f.store.review(
      'user',
      id,
      1,
      { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
      'operator',
    );
    f.qualify.mockImplementationOnce(async () => {
      revokeAuthSession(auth);
    });
    await request(app)
      .post(`/builder/drafts/${id}/1/publish`)
      .send({ contractDigest: f.draft.contractDigest })
      .expect(400);
    expect(f.store.listTools('user')).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});

it('reviews only through an authenticated same-origin operator action and keeps publication separate', async () => {
  const f = fixture();
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
  let authenticated = false;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = auth;
    next();
  });
  app.use(
    '/builder',
    createToolBuilderRouter(() => f.store),
  );
  try {
    f.store.save('user', 'builder-session', 'call-1', f.draft, 0);
    f.store.submit('user', 'builder-session', id, 1, f.draft.contractDigest);
    const body = { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest };
    await request(app).post(`/builder/drafts/${id}/1/review`).send(body).expect(403);
    authenticated = true;
    await request(app)
      .post(`/builder/drafts/${id}/1/review`)
      .set('Origin', 'https://evil.example')
      .send(body)
      .expect(403);
    await request(app)
      .post(`/builder/drafts/${id}/1/review`)
      .send({ ...body, reviewer: 'builder-session' })
      .expect(400);
    expect(f.store.read('user', id, 1)?.status).toBe('submitted');
    await request(app).post(`/builder/drafts/${id}/1/review`).send(body).expect(200);
    expect(f.store.read('user', id, 1)?.review?.reviewer).toBe('user');
    expect(f.store.listTools('user')).toEqual([]);
    const listed = await request(app).get('/builder').expect(200);
    expect(listed.body.drafts[0].status).toBe('accepted');
    expect(listed.body.drafts[0]).not.toHaveProperty('files');
    const detail = await request(app).get(`/builder/drafts/${id}/1`).expect(200);
    expect(detail.body.draft.files).toEqual(f.draft.files);
    await request(app)
      .post(`/builder/drafts/${id}/1/publish`)
      .send({ contractDigest: f.draft.contractDigest })
      .expect(200);
    revokeAuthSession(auth);
    await request(app).get('/builder').expect(403);
    expect(f.execute).toHaveBeenCalledOnce();
  } finally {
    f.store.close();
  }
});
