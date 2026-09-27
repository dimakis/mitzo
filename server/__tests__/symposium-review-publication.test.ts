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
    approvalInput: null as import('../connections/types.js').JsonValue | null,
    approvalHash: null as string | null,
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
      gatewayProviderId: 'gateway-provider',
      status: 'active',
      templateId: 'github-readonly',
      templateVersion: 1,
      revision: 1,
      desiredAccountIds: ['account'],
    }),
    getLiveAttachment: vi
      .fn<() => import('../symposium-review-publication.js').ReviewPublicationAttachment | null>()
      .mockReturnValue({
        sessionId: 'session',
        seatId: 'builder',
        membershipGeneration: 1,
        accountId: 'account',
        connectionId: 'connection',
        connectionRevision: 1,
        gatewayProviderId: 'gateway-provider',
        sandboxName: 'sandbox',
        workspace: '/sandbox/symposium-artifacts',
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

it('keeps Symposium inspection separate from the unchanged publisher transport', async () => {
  const { OpenShellSymposiumGitInspection } = await import('../symposium-review-git-inspection.js');
  const control = vi
    .fn<(args: readonly string[]) => Promise<string>>()
    .mockResolvedValue(`100644 blob ${'a'.repeat(40)}\tfile.txt\0`);
  const transport = new OpenShellSymposiumGitInspection(control, 'work');
  expect(transport).not.toHaveProperty('exportBundle');
  expect(transport).not.toHaveProperty('execute');
  await transport.committedTree({
    sandboxName: 'sandbox',
    repositoryPath: '/sandbox/symposium-artifacts/repo',
    sourceOid: 'b'.repeat(40),
    signal: new AbortController().signal,
  });
  expect(control.mock.calls[0][0]).toContain('/sandbox/symposium-artifacts');
  await expect(
    transport.committedTree({
      sandboxName: 'sandbox',
      repositoryPath: '/sandbox/workspaces/work/repo',
      sourceOid: 'b'.repeat(40),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('Repository path is invalid');
  expect(control).toHaveBeenCalledOnce();
});

it('accepts a valid empty committed tree with the versioned empty-array digest', () => {
  expect(committedTreeDigest('')).toBe(
    createHash('sha256').update('mitzo-committed-tree-v1\0[]').digest('hex'),
  );
});
it('requires the live builder sandbox attachment and rejects detachment during preflight', async () => {
  const f = fixture();
  f.deps.getLiveAttachment.mockReturnValueOnce(null);
  await expect(f.inspect()).rejects.toThrow('live attachment');
  expect(f.deps.control).not.toHaveBeenCalled();
  const g = fixture();
  g.deps.publisher.findOpen.mockImplementation(async () => {
    g.deps.getLiveAttachment.mockReturnValue(null);
    return null;
  });
  await expect(g.inspect()).rejects.toThrow('live attachment');
});
it('refuses to replace a persisted pending approval card or accept a corrupt approval hash', async () => {
  const f = fixture();
  const preview = await f.inspect();
  f.binding.operation.approvalInput = { ...preview.approvalInput, sourceBranch: 'feature/other' };
  f.binding.operation.approvalHash = createHash('sha256')
    .update(canonicalJson(f.binding.operation.approvalInput))
    .digest('hex');
  await expect(f.inspect()).rejects.toThrow('pending approval');
  f.binding.operation.approvalInput = { ...preview.approvalInput };
  f.binding.operation.approvalHash = 'a'.repeat(64);
  await expect(f.inspect()).rejects.toThrow('pending approval');
});
it('accepts an unchanged persisted approval but rejects an attachment to another sandbox', async () => {
  const f = fixture();
  const preview = await f.inspect();
  f.binding.operation.approvalInput = { ...preview.approvalInput };
  f.binding.operation.approvalHash = createHash('sha256')
    .update(canonicalJson(preview.approvalInput))
    .digest('hex');
  expect((await f.inspect()).kind).toBe('preview_only');
  f.deps.getLiveAttachment.mockReturnValue({
    ...f.deps.getLiveAttachment()!,
    sandboxName: 'other-sandbox',
  });
  await expect(f.inspect()).rejects.toThrow('live attachment');
});

it('accepts dotted OpenShell workspace identities without broadening sandbox names', async () => {
  const f = fixture();
  f.deps.workspaceId = 'work.test';
  f.binding.lease.request.workspaceId = 'work.test';
  const inspectVolume = f.deps.leaseHost.inspectVolume;
  f.deps.leaseHost.inspectVolume = async () => {
    const volume = await inspectVolume();
    volume.labels['openshell.ai/sandbox-attachable-workspace'] = 'work.test';
    volume.labels['mitzo.symposium.workspace'] = 'work.test';
    return volume;
  };
  await expect(f.inspect()).resolves.toMatchObject({ kind: 'preview_only' });
  expect(f.deps.control.mock.calls.every(([args]) => args[2] === 'work.test')).toBe(true);
  f.binding.sandboxName = 'sandbox.invalid';
  f.deps.getLiveAttachment.mockReturnValue({
    ...f.deps.getLiveAttachment()!,
    sandboxName: 'sandbox.invalid',
  });
  await expect(f.inspect()).rejects.toThrow('Sandbox identity is invalid');
});

it('rejects a live attachment belonging to a different physical connection provider', async () => {
  const f = fixture();
  const connection = f.deps.getConnection();
  f.deps.getConnection = () => ({ ...connection, gatewayProviderId: 'replaced-provider' });
  await expect(f.inspect()).rejects.toThrow('Publication live attachment unavailable');
  expect(f.deps.control).not.toHaveBeenCalled();
});

it('rechecks the connection provider after asynchronous inspection', async () => {
  const f = fixture();
  const connection = f.deps.getConnection();
  f.deps.getConnection = () => connection;
  f.deps.publisher.policy.mockImplementation(async () => {
    connection.gatewayProviderId = 'replacement-provider';
    return { defaultBranch: 'main', sourceBranchProtected: false };
  });
  await expect(f.inspect()).rejects.toThrow('Publication live attachment unavailable');
});

import {
  createSymposiumReviewPublicationExecutor,
  type ReviewPublicationExecutorDependencies,
} from '../symposium-review-publication-executor.js';
import { CapabilityService } from '../connections/capabilities/service.js';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
import { CapabilityExecutorRegistry } from '../connections/capabilities/registry.js';
import { connectionTemplateRegistry } from '../connections/registry.js';

function executionFixture() {
  const f = fixture();
  const operations = new CapabilityOperationStore(':memory:');
  operations.upsertGrant({
    id: 'grant',
    connectionId: 'connection',
    connectionRevision: 1,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: ['account'],
    status: 'active',
  });
  const pull = {
    repository: 'acme/repo',
    sourceBranch: 'feature/review',
    baseBranch: 'main',
    url: 'https://github.com/acme/repo/pull/1',
    id: '1',
    title: f.input.title,
    body: f.input.body,
    draft: true,
  };
  const publisher = {
    ...f.deps.publisher,
    reconstruct: vi.fn(async () => ({ directory: '/mock-host' })),
    push: vi.fn(async () => {}),
    create: vi.fn(async () => pull),
    update: vi.fn(async () => pull),
    read: vi.fn(async () => pull),
    readBranch: vi.fn(async () => 'c'.repeat(40)),
    cleanup: vi.fn(async () => {}),
  };
  const seal = {
    id: 'sealed',
    revision: '1',
    artifactRevision: f.record.snapshot.artifactRevision,
    artifactHash: f.record.snapshot.artifactHash,
    withHold: async <T>(_id: string, work: (check: () => Promise<void>) => Promise<T>) =>
      work(async () => {}),
  };
  const deps = {
    ...f.deps,
    operations,
    publisher,
    exportBundle: vi.fn(async () => Buffer.from('mock-bundle')),
    resolveReview: vi.fn(
      (operation: import('../connections/capabilities/types.js').CapabilityOperation) => {
        f.binding.operation = {
          ...operation,
          approvalInput: operation.approvalInput ?? null,
          approvalHash: operation.approvalHash ?? null,
        };
        return { context: { owner: 'user', sessionId: 'session' }, recordId: f.record.recordId };
      },
    ),
    resolveBinding: () => ({ ...f.binding, operation: operations.get(f.binding.operation.id)! }),
    getPublicationSeal: vi.fn(() => seal),
  };
  const executor = createSymposiumReviewPublicationExecutor(
    deps as unknown as ReviewPublicationExecutorDependencies,
  );
  const template = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1)!;
  const approve = vi.fn(async () => true);
  const service = new CapabilityService({
    store: operations,
    executorRegistry: new CapabilityExecutorRegistry({ [template.executor]: executor }),
    getTemplate: () => template,
    getConnection: f.deps.getConnection,
    listConnections: () => [f.deps.getConnection()],
    isConnectionActiveForConversation: () => true,
    approve,
  });
  const request = {
    capabilityId: template.id,
    capabilityVersion: 1,
    connectionId: 'connection',
    connectionRevision: 1,
    accountId: 'account',
    conversationId: 'session',
    turnId: 'turn',
    idempotencyKey: 'publish',
    input: f.input,
  };
  const invoke = () => service.invoke(request, new AbortController().signal);
  return { ...f, deps, operations, publisher, seal, approve, invoke, executor };
}

it('uses real durable forced approval and idempotency for a sealed reviewed publication', async () => {
  const f = executionFixture();
  const result = await f.invoke();
  expect(result.status).toBe('succeeded');
  expect(f.approve).toHaveBeenCalledWith(
    expect.objectContaining({
      forcePrompt: true,
      input: expect.objectContaining({
        sourceOid: f.record.snapshot.artifactRevision,
        body: f.input.body,
      }),
    }),
    expect.any(AbortSignal),
  );
  expect(result.recoveryIntent).toMatchObject({
    symposiumRecordId: f.record.recordId,
    symposiumSealId: 'sealed',
  });
  expect((await f.invoke()).status).toBe('succeeded');
  expect(f.publisher.create).toHaveBeenCalledOnce();
  expect(f.approve).toHaveBeenCalledOnce();
});
it('requires a completed seal before asking for approval', async () => {
  const f = executionFixture();
  f.deps.getPublicationSeal.mockReturnValue(null as never);
  expect((await f.invoke()).status).toBe('failed');
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.publisher.push).not.toHaveBeenCalled();
});
it.each(['seal', 'membership', 'review', 'grant'] as const)(
  'rejects changed %s during approval before writing',
  async (change) => {
    const f = executionFixture();
    f.approve.mockImplementation(async () => {
      if (change === 'seal') f.seal.revision = '2';
      if (change === 'membership') f.binding.membershipGeneration = 2;
      if (change === 'review') f.record.contentHash = 'd'.repeat(64);
      if (change === 'grant')
        f.operations.upsertGrant({
          id: 'grant',
          connectionId: 'connection',
          connectionRevision: 1,
          capabilityId: 'github.publish-pr',
          capabilityVersion: 1,
          accountIds: ['account'],
          status: 'revoked',
        });
      return true;
    });
    expect((await f.invoke()).status).not.toBe('succeeded');
    expect(f.publisher.push).not.toHaveBeenCalled();
    expect(f.publisher.create).not.toHaveBeenCalled();
  },
);
it('recovers an ambiguous created PR by read-only outcome lookup without redispatch or reapproval', async () => {
  const f = executionFixture();
  f.publisher.create.mockImplementation(async () => {
    throw new Error('Lost response after create');
  });
  const first = await f.invoke();
  expect(first.status).toBe('verification_pending');
  f.deps.getPublicationSeal.mockReturnValue(null as never);
  f.publisher.findOpen.mockResolvedValue((await f.publisher.read()) as never);
  const recovered = await f.invoke();
  expect(recovered.status).toBe('succeeded');
  expect(f.publisher.create).toHaveBeenCalledOnce();
  expect(f.publisher.push).toHaveBeenCalledOnce();
  expect(f.approve).toHaveBeenCalledOnce();
});
it('cleans a reconstructed host directory if seal verification fails before push', async () => {
  const f = executionFixture();
  let valid = true;
  f.seal.withHold = async (_id, work) =>
    work(async () => {
      if (!valid) throw new Error('Seal lost');
    });
  f.publisher.reconstruct.mockImplementation(async () => {
    valid = false;
    return { directory: '/mock-host' };
  });
  expect((await f.invoke()).status).toBe('verification_pending');
  expect(f.publisher.cleanup).toHaveBeenCalledWith('/mock-host');
  expect(f.publisher.push).not.toHaveBeenCalled();
});
it('does not settle a lost existing-PR update whose approved review metadata was never applied', async () => {
  const f = executionFixture();
  const stale = { ...(await f.publisher.read()), title: 'Old title', body: 'No review record' };
  f.publisher.findOpen.mockResolvedValue(stale as never);
  f.publisher.read.mockResolvedValue(stale);
  f.publisher.update.mockImplementation(async () => {
    throw new Error('Lost update response');
  });
  expect((await f.invoke()).status).toBe('verification_pending');
  expect((await f.invoke()).status).toBe('verification_pending');
  expect(f.publisher.update).toHaveBeenCalledOnce();
  expect(f.publisher.push).toHaveBeenCalledOnce();
  expect(f.approve).toHaveBeenCalledOnce();
  f.publisher.read.mockResolvedValue({ ...stale, title: f.input.title, body: f.input.body });
  expect((await f.invoke()).status).toBe('succeeded');
  expect(f.publisher.update).toHaveBeenCalledOnce();
});
