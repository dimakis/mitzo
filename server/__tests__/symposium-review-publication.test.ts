import { expect, it, vi } from 'vitest';
import {
  committedTreeDigest,
  createSymposiumReviewPublicationPreflight,
} from '../symposium-review-publication.js';

it('binds regular committed tree paths, executable modes and Git object identities', () => {
  const tree = `100644 blob ${'a'.repeat(40)}\tfile.txt\0`;
  expect(committedTreeDigest(tree)).toMatch(/^[a-f0-9]{64}$/);
  expect(committedTreeDigest(tree)).not.toBe(committedTreeDigest(tree.replace('100644', '100755')));
  expect(committedTreeDigest(tree)).not.toBe(
    committedTreeDigest(tree.replace('file.txt', 'other.txt')),
  );
  expect(() => committedTreeDigest(tree.replace('100644', '120000'))).toThrow();
  expect(() => committedTreeDigest(tree + tree)).toThrow();
  expect(() => committedTreeDigest(tree.replace('file.txt', '../escape'))).toThrow();
});

it('does not provide execution or approval methods', () => {
  const adapter = createSymposiumReviewPublicationPreflight({} as never);
  expect(adapter).not.toHaveProperty('execute');
  expect(adapter).not.toHaveProperty('approve');
  expect(adapter).not.toHaveProperty('publish');
});

import { createHash } from 'node:crypto';
import { canonicalJson } from '../connections/capabilities/input-validation.js';
import type { ReviewPublicationDependencies } from '../symposium-review-publication.js';
function fixture() {
  const tree = `100644 blob ${'a'.repeat(40)}\tfile.txt\0`;
  const hash = committedTreeDigest(tree);
  const builder = {
    seatId: 'builder',
    role: 'coder',
    selectionId: 's',
    policyRevision: 'p',
    profileId: 'profile',
    profileRevision: 1,
    accountId: 'account',
    model: 'mock',
  };
  const context = { owner: 'user', sessionId: 'session' };
  const record = {
    recordId: `review-${'b'.repeat(64)}`,
    contentHash: 'b'.repeat(64),
    snapshot: {
      ...context,
      workflowId: 'flow',
      artifactRevision: 'c'.repeat(40),
      artifactHash: hash,
      historySequence: 1,
      workflow: { implementer: builder },
    },
  };
  const input = {
    connectionId: 'connection',
    repositoryPath: '/sandbox/symposium-artifacts/repo',
    baseBranch: 'main',
    title: 'Reviewed change',
    body: `Review record: ${record.recordId}\nSHA256: ${record.contentHash}`,
    draft: true,
  };
  const operation = {
    id: 'operation',
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    conversationId: 'session',
    accountId: 'account',
    connectionId: 'connection',
    connectionRevision: 1,
    grantId: 'grant',
    status: 'pending_approval',
    inputHash: createHash('sha256').update(canonicalJson(input)).digest('hex'),
  };
  const lease = {
    token: 'lease',
    revision: '1',
    request: {
      sessionId: 'session',
      workspaceId: 'work',
      seatId: 'builder',
      volumeName: 'volume',
      volumeGeneration: 'generation',
      driver: 'podman',
      access: 'writer',
    },
  };
  const binding = {
    builder,
    membershipGeneration: 1,
    sandboxName: 'sandbox',
    lease,
    operation,
    publicConfig: { allowedRepositories: ['acme/repo'], allowedBaseBranches: ['main'] },
  };
  const control = vi.fn(async (args: readonly string[]) => {
    const cmd = args.slice(args.indexOf('mitzo-github-git') + 3);
    if (cmd[0] === 'ls-tree') return tree;
    if (cmd[0] === 'status') return '';
    if (cmd[0] === 'rev-parse') return 'c'.repeat(40);
    if (cmd[0] === 'symbolic-ref') return 'feature/review';
    if (cmd[0] === 'remote') return 'https://github.com/acme/repo.git';
    if (cmd[0] === 'rev-list') return '1';
    if (cmd[0] === '-c') return 'file.txt\n';
    throw new Error('Unexpected command');
  });
  const deps = {
    store: {
      getReviewRecord: vi.fn(() => record),
      get: vi.fn(() => ({
        workflowId: 'flow',
        status: 'verified',
        artifactRevision: record.snapshot.artifactRevision,
        artifactHash: record.snapshot.artifactHash,
      })),
      history: () => [{ sequence: 1 }],
    },
    operations: {
      get: () => operation,
      getGrant: () => ({ id: 'grant', status: 'active', accountIds: ['account'] }),
    },
    leaseHost: {
      inspectLease: vi.fn(async () => lease),
      verifyDriverConfig: vi.fn(async () => {}),
      inspectVolume: async () => ({
        name: 'volume',
        driver: 'local',
        options: {},
        labels: {
          'openshell.ai/sandbox-attachable': 'true',
          'openshell.ai/sandbox-attachable-workspace': 'work',
          'mitzo.symposium.purpose': 'artifacts',
          'mitzo.symposium.session': 'session',
          'mitzo.symposium.workspace': 'work',
          'mitzo.symposium.generation': 'generation',
        },
      }),
      reserve: vi.fn(),
      release: vi.fn(),
    },
    control,
    workspaceId: 'work',
    publisher: {
      policy: vi.fn(async () => ({ defaultBranch: 'main', sourceBranchProtected: false })),
      findOpen: vi.fn(async () => null),
    },
    getConnection: () => ({
      id: 'connection',
      status: 'active',
      templateId: 'github-readonly',
      templateVersion: 1,
      revision: 1,
      desiredAccountIds: ['account'],
    }),
    resolveBinding: vi.fn(() => binding),
  };
  const inspect = () =>
    createSymposiumReviewPublicationPreflight(
      deps as unknown as ReviewPublicationDependencies,
    ).inspect(context, record.recordId, input, new AbortController().signal);
  return { deps, record, binding, input, inspect };
}
it('uses real Git preflight validation and returns only a preview without reserving or mutating', async () => {
  const f = fixture();
  expect(await f.inspect()).toMatchObject({
    kind: 'preview_only',
    publication: 'not_created',
    approvalInput: { sourceOid: 'c'.repeat(40), repository: 'acme/repo', draft: true },
  });
  expect(f.deps.leaseHost.reserve).not.toHaveBeenCalled();
  expect(f.deps.leaseHost.release).not.toHaveBeenCalled();
  expect(f.deps.control.mock.calls.every(([args]) => args.includes('mitzo-github-git'))).toBe(true);
  expect(f.deps.publisher.policy).toHaveBeenCalledOnce();
});
it('rejects a review hash that does not bind the actual committed tree', async () => {
  const f = fixture();
  f.record.snapshot.artifactHash = 'd'.repeat(64);
  await expect(f.inspect()).rejects.toThrow('does not match');
  expect(f.deps.publisher.policy).not.toHaveBeenCalled();
});
it('rechecks the lease after remote preflight reads', async () => {
  const f = fixture();
  f.deps.publisher.findOpen.mockImplementation(async () => {
    f.deps.leaseHost.inspectLease.mockResolvedValue({ ...f.binding.lease, revision: '2' });
    return null;
  });
  await expect(f.inspect()).rejects.toThrow('lease drift');
});
it('rejects rebound builder and changed operation input', async () => {
  const f = fixture();
  f.binding.builder = { ...f.binding.builder, accountId: 'other' };
  await expect(f.inspect()).rejects.toThrow('seat or lease mismatch');
  const g = fixture();
  g.input.title = 'Unreviewed input';
  await expect(g.inspect()).rejects.toThrow('input changed');
});
it('rejects branch and grant policy failures without publisher mutation', async () => {
  const f = fixture();
  f.binding.publicConfig.allowedRepositories = ['acme/other'];
  await expect(f.inspect()).rejects.toThrow('not allowed');
  const g = fixture();
  g.deps.operations.getGrant = () => ({ id: 'grant', status: 'revoked', accountIds: ['account'] });
  await expect(g.inspect()).rejects.toThrow('binding unavailable');
  expect(g.deps.control).not.toHaveBeenCalled();
});

it('rejects changed Git HEAD after the capability preflight remote reads', async () => {
  const f = fixture();
  f.deps.publisher.findOpen.mockImplementation(async () => {
    const read = f.deps.control.getMockImplementation()!;
    f.deps.control.mockImplementation(async (args) =>
      args.includes('rev-parse') ? 'd'.repeat(40) : read(args),
    );
    return null;
  });
  await expect(f.inspect()).rejects.toThrow('does not match');
});

it('keeps endpoint unavailable without the trusted review host and scopes records before inspecting', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createSymposiumReviewRouter } = await import('../symposium-review-routes.js');
  const f = fixture();
  let available = false;
  let authenticated = true;
  const adapter = createSymposiumReviewPublicationPreflight(
    f.deps as unknown as ReviewPublicationDependencies,
  );
  const getPreflight = vi.fn(() => adapter);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (authenticated) res.locals.authSession = { id: 'login' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouter({
      store: f.deps.store as never,
      hasSession: () => true,
      getHost: () => (available ? ({} as never) : null),
      getPublicationPreflight: getPreflight,
    }),
  );
  const endpoint = `/api/sessions/session/symposium/reviews/records/${f.record.recordId}/publication-preflight`;
  const blocked = await request(app).post(endpoint).send(f.input);
  expect(blocked.status).toBe(409);
  expect(blocked.body).toMatchObject({
    code: 'review_publication_unavailable',
    publication: 'not_created',
  });
  expect(getPreflight).not.toHaveBeenCalled();
  expect(f.deps.control).not.toHaveBeenCalled();
  available = true;
  const preview = await request(app).post(endpoint).send(f.input);
  expect(preview.status).toBe(200);
  expect(preview.body.kind).toBe('preview_only');
  expect(preview.headers['cache-control']).toBe('no-store');
  expect(f.deps.store.getReviewRecord).toHaveBeenCalledWith('user', 'session', f.record.recordId);
  authenticated = false;
  expect((await request(app).post(endpoint).send(f.input)).status).toBe(403);
});

it('rejects a dirty tree appearing after remote reads even when committed HEAD is unchanged', async () => {
  const f = fixture();
  f.deps.publisher.findOpen.mockImplementation(async () => {
    const read = f.deps.control.getMockImplementation()!;
    f.deps.control.mockImplementation(async (args) =>
      args.includes('status') ? ' M file.txt\n' : read(args),
    );
    return null;
  });
  await expect(f.inspect()).rejects.toThrow('Git state changed after publication preflight');
});
