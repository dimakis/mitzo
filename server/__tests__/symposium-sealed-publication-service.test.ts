import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityService } from '../connections/capabilities/service.js';
import { CapabilityExecutorRegistry } from '../connections/capabilities/registry.js';
import { CredentialResolver } from '../credentials.js';
import { PublicationCredentialCustodian } from '../symposium-publication-credentials.js';
import { expect, it, vi } from 'vitest';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
import {
  SealedPublicationAuthority,
  PublicationCredentialHttpError,
  type PublicationCredentialHandle,
  type SealedPublicationScope,
} from '../symposium-sealed-publication-authority.js';
import { SealedPublicationService } from '../symposium-sealed-publication-service.js';
async function fixture(
  registered = true,
  mixedCase = false,
  unbornBranch = false,
  useCustodian = false,
  onCreate?: () => Promise<void>,
  operationPath = ':memory:',
  operatorId = 'operator',
) {
  const scope: SealedPublicationScope = {
    operatorId,
    sessionId: 'session',
    recordId: 'review',
    recordHash: 'a'.repeat(64),
    sealId: 'seal',
    sealHash: 'b'.repeat(64),
    repository: mixedCase ? 'Owner/Repo' : 'owner/repo',
    connectionId: 'selected',
    connectionRevision: 1,
    credentialGeneration: 'generation',
  };
  const oid = 'c'.repeat(40),
    signal = new AbortController().signal;
  const body = `Reviewed change\nReview record: review\nSHA256: ${scope.recordHash}`;
  let created = false,
    loseResponse = false,
    staleMetadata = false,
    current = true;
  const pr = () => ({
    number: 7,
    html_url: 'https://github.com/owner/repo/pull/7',
    title: staleMetadata ? 'wrong' : 'Approved',
    body,
    draft: true,
    state: 'open',
    head: { ref: 'feature' },
    base: { ref: 'main', repo: { full_name: 'owner/repo' } },
  });
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'git')
      return {
        stdout: args.includes('rev-parse')
          ? oid
          : args[0] === 'ls-remote'
            ? `${oid} refs/heads/feature`
            : '',
      };
    if (args.includes('/user'))
      return { stdout: JSON.stringify({ id: 42, login: 'selected-user', type: 'User' }) };
    const endpoint = args.find((a) => a.startsWith('repos/'));
    if (endpoint === 'repos/owner/repo')
      return { stdout: JSON.stringify({ full_name: 'owner/repo', default_branch: 'main' }) };
    if (endpoint === 'repos/owner/repo/rules/branches/feature') return { stdout: '[]' };
    if (endpoint === 'repos/owner/repo/branches/feature' && unbornBranch && !created)
      throw new PublicationCredentialHttpError(404);
    if (endpoint === 'repos/owner/repo/branches/feature')
      return { stdout: JSON.stringify({ protected: false, commit: { sha: oid } }) };
    if (endpoint === 'repos/owner/repo/pulls' && args.includes('POST')) {
      created = true;
      await onCreate?.();
      if (loseResponse) throw Error('response lost');
      return { stdout: JSON.stringify(pr()) };
    }
    if (endpoint === 'repos/owner/repo/pulls')
      return { stdout: JSON.stringify(created ? [pr()] : []) };
    if (endpoint === 'repos/owner/repo/pulls/7') return { stdout: JSON.stringify(pr()) };
    throw Error('Unexpected mocked command');
  });
  let handle: PublicationCredentialHandle = {
    connectionId: 'selected',
    revision: 1,
    generation: 'generation',
    assertCurrent: () => {
      if (!current) throw Error('revoked');
      return true;
    },
    run,
  };
  if (useCustodian) {
    const custody = new PublicationCredentialCustodian(
      new CredentialResolver({ test: { resolve: async () => 'fixture-only-secret' } }),
      async (command, args) => {
        try {
          return await run(command, args);
        } catch (error) {
          if (error instanceof PublicationCredentialHttpError)
            throw { stderr: 'gh: Not Found (HTTP 404)\n' };
          throw error;
        }
      },
    );
    custody.register('selected', 'Selected operator', {
      provider: 'test',
      service: 'publication',
      account: 'operator',
    });
    handle = await custody.select('selected', 1);
    scope.credentialGeneration = handle.generation;
  }
  const operators = new Set([operatorId]);
  const authority = new SealedPublicationAuthority(':memory:', {
    assertOperator: (id) => {
      if (!operators.has(id)) throw Error('Operator expired');
      return true;
    },
    assertArtifact: async () => {},
    resolveCredential: () => (current ? handle : null),
  });
  const grant = await authority.grant(
    scope,
    { host: 'github.com', numericId: 42, login: 'selected-user' },
    signal,
  );
  const operations = new CapabilityOperationStore(operationPath);
  const exportBundle = vi.fn(async () => Buffer.from('mocked git bundle'));
  const artifact = {
    require: vi.fn(async () => ({
      workspace: '/artifact',
      repositoryPath: '/artifact',
      sourceOid: oid,
    })),
    inspectCompletedArtifact: vi.fn(async () => ({
      canonicalRepositoryPath: '/artifact',
      status: '',
      sourceBranch: 'feature',
      sourceOid: oid,
      defaultBranch: 'main',
      originUrl: 'https://github.com/owner/repo.git',
      commitsAhead: 1,
      changedFiles: ['file.txt'],
      sourceBranchProtected: false,
      symlinkFree: true,
    })),
    exportCompletedArtifactBundle: exportBundle,
  };
  const service = new SealedPublicationService({
    authority,
    operations,
    artifact,
    credentialCustodianRegistered: registered,
  });
  const input = {
    grantId: grant.id,
    bindingHash: grant.bindingHash,
    turnId: 'turn',
    idempotencyKey: 'key',
    publication: {
      repositoryPath: '/artifact',
      baseBranch: 'main',
      title: 'Approved',
      body,
      draft: true,
    },
  };
  return {
    authority,
    operators,
    operations,
    service,
    input,
    signal,
    run,
    exportBundle,
    artifact,
    grant,
    revoke: () => {
      current = false;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    staleMetadata: () => {
      staleMetadata = true;
    },
    close: () => {
      authority.close();
      operations.close();
    },
  };
}
it('runs selected principal through forced approval, sealed export and exact-handle publisher once', async () => {
  const f = await fixture();
  const approve = vi.fn(async (card) => {
    expect(card.forcePrompt).toBe(true);
    expect(card.input.publicationGithubId).toBe('42');
    expect(f.exportBundle).not.toHaveBeenCalled();
    return true;
  });
  const result = await f.service.invoke(f.input, f.signal, approve);
  expect(result.status).toBe('succeeded');
  expect(f.exportBundle).toHaveBeenCalledTimes(1);
  expect(f.run.mock.calls.filter(([, a]) => a.includes('POST'))).toHaveLength(1);
  const replay = await f.service.invoke(f.input, f.signal, approve);
  expect(replay.id).toBe(result.id);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(f.exportBundle).toHaveBeenCalledTimes(1);
  f.close();
});
it('does not export or write when approval is denied', async () => {
  const f = await fixture();
  expect((await f.service.invoke(f.input, f.signal, async () => false)).status).toBe('denied');
  expect(f.exportBundle).not.toHaveBeenCalled();
  expect(f.run.mock.calls.some(([, a]) => a.includes('POST'))).toBe(false);
  f.close();
});
it('rejects credential revocation at approval without ambient runner fallback', async () => {
  const f = await fixture();
  const result = await f.service.invoke(f.input, f.signal, async () => {
    f.revoke();
    return true;
  });
  expect(result.status).toBe('cancelled');
  expect(f.exportBundle).not.toHaveBeenCalled();
  expect(f.run.mock.calls.some(([, a]) => a.includes('POST'))).toBe(false);
  f.close();
});
it('recovers a lost create response with reads only and never repeats export or POST', async () => {
  const f = await fixture();
  f.loseResponse();
  const approve = vi.fn(async () => true);
  const pending = await f.service.invoke(f.input, f.signal, approve);
  expect(pending.status).toBe('verification_pending');
  const recovered = await f.service.invoke(f.input, f.signal, approve);
  expect(recovered.status).toBe('succeeded');
  expect(f.run.mock.calls.filter(([, a]) => a.includes('POST'))).toHaveLength(1);
  expect(f.exportBundle).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledTimes(1);
  f.close();
});
it('reports actionable unavailable state with no registered custodian', async () => {
  const f = await fixture(false);
  expect(f.service.availability()).toMatchObject({
    available: false,
    code: 'PUBLICATION_CREDENTIAL_REGISTRATION_REQUIRED',
  });
  await expect(f.service.invoke(f.input, f.signal, async () => true)).rejects.toThrow(
    'REGISTRATION_REQUIRED',
  );
  expect(f.exportBundle).not.toHaveBeenCalled();
  f.close();
});

it('leaves stale metadata pending during read-only recovery', async () => {
  const f = await fixture();
  f.loseResponse();
  await f.service.invoke(f.input, f.signal, async () => true);
  f.staleMetadata();
  const pending = await f.service.invoke(f.input, f.signal, async () => true);
  expect(pending.status).toBe('verification_pending');
  expect(f.run.mock.calls.filter(([, a]) => a.includes('POST'))).toHaveLength(1);
  expect(f.exportBundle).toHaveBeenCalledTimes(1);
  f.close();
});

it('checks applicable branch rules for an unborn source using the selected handle', async () => {
  const f = await fixture(true, false, true);
  expect((await f.service.invoke(f.input, f.signal, async () => true)).status).toBe('succeeded');
  expect(
    f.run.mock.calls.some(([, args]) => args.includes('repos/owner/repo/rules/branches/feature')),
  ).toBe(true);
  f.close();
});
it('canonicalizes a mixed-case selected repository before persisting its grant', async () => {
  const f = await fixture(true, true);
  expect(f.grant.scope.repository).toBe('owner/repo');
  expect((await f.service.invoke(f.input, f.signal, async () => true)).status).toBe('succeeded');
  f.close();
});

it.each(['invalid branch', 'main'])(
  'uses the current base branch after an earlier %s request under the same grant',
  async (firstBaseBranch) => {
    const f = await fixture();
    const firstApproval = vi.fn(async () => false);
    const first = await f.service.invoke(
      { ...f.input, publication: { ...f.input.publication, baseBranch: firstBaseBranch } },
      f.signal,
      firstApproval,
    );
    expect(first.status).toBe(firstBaseBranch === 'main' ? 'denied' : 'failed');
    const currentApproval = vi.fn(async (card) => {
      expect(card.input.baseBranch).toBe('release');
      return false;
    });
    const current = await f.service.invoke(
      {
        ...f.input,
        idempotencyKey: 'current-base-branch',
        publication: { ...f.input.publication, baseBranch: 'release' },
      },
      f.signal,
      currentApproval,
    );
    expect(current.status).toBe('denied');
    expect(currentApproval).toHaveBeenCalledTimes(1);
    expect(f.exportBundle).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([, args]) => args.includes('POST'))).toBe(false);
    f.close();
  },
);

it('publishes an absent source branch through the concrete custodian without losing 404 semantics', async () => {
  const f = await fixture(true, false, true, true);
  expect((await f.service.invoke(f.input, f.signal, async () => true)).status).toBe('succeeded');
  expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
  f.close();
});

it('keeps sealed operations outside legacy shared-ledger startup and reconnect recovery', async () => {
  const f = await fixture();
  f.loseResponse();
  const pending = await f.service.invoke(f.input, f.signal, async () => true);
  expect(pending.status).toBe('verification_pending');
  const getTemplate = vi.fn();
  const legacy = new CapabilityService({
    store: f.operations,
    ownsOperation: (operation) => !operation.connectionId.startsWith('sealed-publication-'),
    executorRegistry: new CapabilityExecutorRegistry({}),
    getTemplate,
    getConnection: () => undefined,
    listConnections: () => [],
    isConnectionActiveForConversation: () => false,
    approve: async () => false,
  });
  expect(await legacy.recoverPending(f.signal)).toEqual([]);
  expect(
    await legacy.recoverPendingForConversation(pending.accountId, pending.conversationId, f.signal),
  ).toEqual([]);
  expect(getTemplate).not.toHaveBeenCalled();
  expect(f.operations.get(pending.id)?.status).toBe('verification_pending');
  expect((await f.service.invoke(f.input, f.signal, async () => true)).status).toBe('succeeded');
  f.close();
});

it('retains the canonical pending publication after a supervised response is lost', async () => {
  const { EventEmitter } = await import('node:events');
  const { createCustodianIpcClient, serveCustodianController } =
    await import('../symposium-custodian-ipc.js');
  const { SymposiumCustodianController } = await import('../symposium-custodian-controller.js');
  class Channel extends EventEmitter {
    peer!: Channel;
    send(frame: unknown) {
      queueMicrotask(() => this.peer.emit('message', frame));
      return true;
    }
  }
  const parent = new Channel(),
    child = new Channel();
  parent.peer = child;
  child.peer = parent;
  const f = await fixture();
  f.loseResponse();
  let resultId = '';
  const controller = new SymposiumCustodianController({
    pause() {},
    resume() {},
    async drain() {},
    invalidate() {},
    async dispatch(_request, _current, approval, signal) {
      const result = await f.service.invoke(f.input, signal!, approval!);
      resultId = result.id;
      child.emit('disconnect');
      parent.emit('disconnect');
      return { status: 200, body: result };
    },
  });
  const stopped = serveCustodianController(parent, controller);
  const client = createCustodianIpcClient(child);
  try {
    await expect(
      client.request(
        {
          requestId: 'lost',
          operation: 'publication.publish',
          sessionId: 'session',
          body: {},
          query: {},
          authorization: { id: 'operator', expiresAt: Date.now() + 10000 },
        },
        async () => true,
      ),
    ).rejects.toThrow('channel');
    await stopped;
    expect(f.operations.get(resultId)?.status).toBe('verification_pending');
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
    // The retained owner uses the same canonical operation; no second export/write.
    const result = await f.service.invoke(f.input, f.signal, async () => {
      throw Error('Unexpected repeated approval');
    });
    expect(result.status).toBe('succeeded');
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('HTTP disconnect after approved mocked dispatch leaves canonical verification pending without retry', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { login } = await import('../auth.js');
  const { createCustodianProxy } = await import('../symposium-custodian-proxy.js');
  let dispatched!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const settle = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(true, false, false, false, async () => {
    dispatched();
    await settle;
  });
  f.loseResponse();
  let resultId = '';
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const app = express();
  app.use(express.json());
  app.use(
    createCustodianProxy(
      {
        invalidate() {},
        async request(_command, approval, signal) {
          signal!.addEventListener('abort', release, { once: true });
          try {
            const result = await f.service.invoke(f.input, signal!, approval!);
            resultId = result.id;
            return { status: 200, body: result };
          } finally {
            completed();
          }
        },
      },
      () => async () => true,
    ),
  );
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const call = request(app)
    .post('/api/sessions/session/symposium/publication/publish')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  const response = call.then(
    () => {},
    () => {},
  );
  try {
    await ready;
    call.abort();
    await response;
    await done;
    expect(f.operations.get(resultId)?.status).toBe('verification_pending');
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
  } finally {
    release();
    f.close();
  }
});

it('reconciles only the original pending operation after fresh auth without another grant or write', async () => {
  const f = await fixture();
  f.loseResponse();
  const pending = await f.service.invoke(f.input, f.signal, async () => true);
  f.operators.delete('operator');
  f.operators.add('fresh');
  const before = structuredClone(pending);
  const reads = f.run.mock.calls.length;
  try {
    await expect(f.service.invoke(f.input, f.signal, async () => true)).rejects.toThrow('expired');
    const recovered = await f.service.recoverExact(
      {
        operationId: pending.id,
        recordId: f.grant.scope.recordId,
        recordHash: f.grant.scope.recordHash,
        sealId: f.grant.scope.sealId,
        sealHash: f.grant.scope.sealHash,
        repository: f.grant.scope.repository,
        grantId: f.grant.id,
        bindingHash: f.grant.bindingHash,
        sessionId: 'session',
        connectionId: 'selected',
        connectionRevision: 1,
        credentialGeneration: 'generation',
      },
      'fresh',
      f.signal,
    );
    expect(recovered.status).toBe('succeeded');
    for (const key of [
      'id',
      'accountId',
      'connectionId',
      'grantId',
      'idempotencyKey',
      'inputHash',
      'approvalInput',
      'approvalHash',
      'recoveryIntent',
    ] as const)
      expect(recovered[key]).toEqual(before[key]);
    expect(
      f.run.mock.calls
        .slice(reads)
        .every(([cmd, args]) => (cmd === 'git' ? args[0] === 'ls-remote' : args.includes('GET'))),
    ).toBe(true);
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
    expect(f.exportBundle).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});

it('refuses success if the original capability grant is revoked during the final awaited recovery read', async () => {
  const f = await fixture();
  f.loseResponse();
  const pending = await f.service.invoke(f.input, f.signal, async () => true);
  f.operators.delete('operator');
  f.operators.add('fresh');
  const original = f.operations.getGrant(
    pending.connectionId,
    pending.connectionRevision,
    pending.capabilityId,
    pending.capabilityVersion,
  )!;
  f.artifact.require.mockImplementation(async () => {
    if (f.run.mock.calls.some(([, args]) => args.includes('repos/owner/repo/pulls/7')))
      f.operations.upsertGrant({ ...original, status: 'revoked' });
    return { workspace: '/artifact', repositoryPath: '/artifact', sourceOid: 'c'.repeat(40) };
  });
  try {
    const result = await f.service.recoverExact(
      {
        recordId: f.grant.scope.recordId,
        recordHash: f.grant.scope.recordHash,
        sealId: f.grant.scope.sealId,
        sealHash: f.grant.scope.sealHash,
        repository: f.grant.scope.repository,
        operationId: pending.id,
        grantId: f.grant.id,
        bindingHash: f.grant.bindingHash,
        sessionId: 'session',
        connectionId: 'selected',
        connectionRevision: 1,
        credentialGeneration: 'generation',
      },
      'fresh',
      f.signal,
    );
    expect(result.status).toBe('verification_pending');
    expect(f.operations.get(pending.id)?.status).toBe('verification_pending');
    expect(f.operations.getGrant(pending.connectionId, 1, pending.capabilityId, 1)?.status).toBe(
      'revoked',
    );
  } finally {
    f.close();
  }
});

function recoverySelection(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  const scope = { ...f.grant.scope };
  Reflect.deleteProperty(scope, 'operatorId');
  return { ...scope, operationId, grantId: f.grant.id, bindingHash: f.grant.bindingHash };
}
it('lists only the exact record and rejects cross-record recovery without any remote read', async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    expect(f.service.recoveryCandidates('session', 'review', 'a'.repeat(64))).toHaveLength(1);
    expect(f.service.recoveryCandidates('session', 'different', 'a'.repeat(64))).toEqual([]);
    expect(f.service.recoveryCandidates('session', 'review', 'b'.repeat(64))).toEqual([]);
    expect(f.service.recoveryCandidates('different', 'review', 'a'.repeat(64))).toEqual([]);
    const before = f.run.mock.calls.length;
    await expect(
      f.service.recoverExact(
        { ...recoverySelection(f, pending.id), recordId: 'different' },
        'operator',
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(before);
  } finally {
    f.close();
  }
});
it.each([
  'grantId',
  'bindingHash',
  'sessionId',
  'connectionId',
  'credentialGeneration',
  'recordHash',
  'sealId',
  'sealHash',
  'repository',
])('rejects altered original %s before recovery reads', async (field) => {
  const f = await fixture();
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    const before = f.run.mock.calls.length;
    await expect(
      f.service.recoverExact(
        { ...recoverySelection(f, pending.id), [field]: 'different' },
        'operator',
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(before);
    expect(f.operations.get(pending.id)?.status).toBe('verification_pending');
  } finally {
    f.close();
  }
});
it.each(['observer', 'credential', 'sealed-grant'])(
  'preserves pending when %s is invalidated during the last awaited read',
  async (kind) => {
    const f = await fixture();
    try {
      f.loseResponse();
      const pending = await f.service.invoke(f.input, f.signal, async () => true);
      f.operators.delete('operator');
      f.operators.add('fresh');
      f.artifact.require.mockImplementation(async () => {
        if (f.run.mock.calls.some(([, args]) => args.includes('repos/owner/repo/pulls/7'))) {
          if (kind === 'observer') f.operators.delete('fresh');
          if (kind === 'credential') f.revoke();
          if (kind === 'sealed-grant') f.authority.revoke(f.grant.id, 'operator', 'session');
        }
        return { workspace: '/artifact', repositoryPath: '/artifact', sourceOid: 'c'.repeat(40) };
      });
      const result = await f.service.recoverExact(
        recoverySelection(f, pending.id),
        'fresh',
        f.signal,
      );
      expect(result.status).toBe('verification_pending');
      expect(f.operations.get(pending.id)?.status).toBe('verification_pending');
    } finally {
      f.close();
    }
  },
);
it('uses the same SQLite operation identity across fresh auth and rejects concurrent exact recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'publication-recovery-'));
  const path = join(directory, 'operations.db');
  const f = await fixture(true, false, false, false, undefined, path);
  const observer = new CapabilityOperationStore(path);
  let release!: () => void;
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    const before = observer.get(pending.id)!;
    f.operators.delete('operator');
    f.operators.add('fresh');
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.artifact.require.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return { workspace: '/artifact', repositoryPath: '/artifact', sourceOid: 'c'.repeat(40) };
    });
    const first = f.service.recoverExact(recoverySelection(f, pending.id), 'fresh', f.signal);
    await waiting;
    await expect(
      f.service.recoverExact(recoverySelection(f, pending.id), 'fresh', f.signal),
    ).rejects.toThrow('Retained exact recovery unavailable');
    expect(observer.get(pending.id)).toEqual(before);
    release();
    await first;
    const after = observer.get(pending.id)!;
    expect(after.status).toBe('succeeded');
    for (const key of [
      'id',
      'accountId',
      'connectionId',
      'grantId',
      'idempotencyKey',
      'inputHash',
      'approvalInput',
      'approvalHash',
      'recoveryIntent',
    ] as const)
      expect(after[key]).toEqual(before[key]);
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
  } finally {
    release?.();
    observer.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('routes fresh login and recent authorization through a replacement controller to the same retained operation', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { login, authenticateToken, operatorAuthMiddleware } = await import('../auth.js');
  const { createCustodianProxy } = await import('../symposium-custodian-proxy.js');
  const { createPublicationRouter } = await import('../symposium-publication-routes.js');
  const { dispatchCustodianHttp } = await import('../symposium-custodian-http.js');
  const { SymposiumCustodianController } = await import('../symposium-custodian-controller.js');
  const oldToken = (await login(process.env.AUTH_PASSPHRASE!))!;
  const oldAuth = (await authenticateToken(oldToken))!;
  const f = await fixture(true, false, false, false, undefined, ':memory:', oldAuth.id);
  const parentApp = express();
  parentApp.use(express.json());
  parentApp.use(operatorAuthMiddleware);
  const registration = {
    service: f.service,
    authorize(auth: { id: string }) {
      f.operators.add(auth.id);
      return f.signal;
    },
  } as unknown as import('../symposium-publication-registration.js').PublicationRegistration;
  const router = () =>
    createPublicationRouter({
      registration: () => registration,
      hasSession: (id) => id === 'session',
      approval: () => {
        throw Error('Recovery must not ask approval');
      },
    });
  parentApp.use('/api/sessions/:id/symposium/publication', router());
  const controller = new SymposiumCustodianController({
    pause() {},
    resume() {},
    async drain() {},
    invalidate(id) {
      f.operators.delete(id);
    },
    dispatch: (command, current, approval, signal) =>
      dispatchCustodianHttp(parentApp, command, current, approval, signal),
  });
  let child = controller.attach();
  function childApp() {
    const app = express();
    app.use(express.json());
    app.use(
      createCustodianProxy({
        invalidate: (id) => child.invalidate(id),
        request: (command, approval, signal) =>
          child.request({ ...command, epoch: child.epoch }, approval, signal),
      }),
    );
    app.use(operatorAuthMiddleware);
    app.use('/api/sessions/:id/symposium/publication', router());
    return app;
  }
  const url = '/api/sessions/session/symposium/publication/recovery';
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    const oldApp = childApp();
    expect(
      (
        await request(oldApp)
          .get(url)
          .query({ recordId: 'review', recordHash: 'a'.repeat(64) })
          .set('Authorization', `Bearer ${oldToken}`)
      ).body.operations[0].operationId,
    ).toBe(pending.id);
    await child.lost();
    child = controller.attach();
    expect(f.operators.has(oldAuth.id)).toBe(false);
    const token = (await login(process.env.AUTH_PASSPHRASE!))!;
    const auth = (await authenticateToken(token))!;
    expect(auth.id).not.toBe(oldAuth.id);
    const app = childApp();
    const body = { ...recoverySelection(f, pending.id) };
    Reflect.deleteProperty(body, 'sessionId');
    expect(
      (await request(app).post(url).set('Authorization', `Bearer ${token}`).send(body)).status,
    ).toBe(403);
    const recent = await request(app)
      .post(url + '/reauthorize')
      .set('Authorization', `Bearer ${token}`)
      .send({ passphrase: process.env.AUTH_PASSPHRASE });
    expect(recent.status).toBe(200);
    expect(
      (
        await request(app)
          .post(url)
          .set('Authorization', `Bearer ${token}`)
          .set('X-CSRF-Token', 'wrong')
          .send(body)
      ).status,
    ).toBe(403);
    // Wrong-CSRF attempt invalidates the capability; explicitly reauthenticate.
    const renewed = await request(app)
      .post(url + '/reauthorize')
      .set('Authorization', `Bearer ${token}`)
      .send({ passphrase: process.env.AUTH_PASSPHRASE });
    const recovered = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', renewed.body.csrf)
      .send(body);
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe('succeeded');
    expect(recovered.body.accountId).toBe(`operator:${oldAuth.id}`);
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
    expect(f.exportBundle).toHaveBeenCalledOnce();
  } finally {
    await child.lost();
    f.close();
  }
});
it('keeps the original pending row when the recovery request disconnects during a read', async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    const abort = new AbortController();
    f.artifact.require.mockImplementation(async () => {
      if (f.run.mock.calls.some(([, args]) => args.includes('repos/owner/repo/pulls/7')))
        abort.abort();
      return { workspace: '/artifact', repositoryPath: '/artifact', sourceOid: 'c'.repeat(40) };
    });
    const result = await f.service.recoverExact(
      recoverySelection(f, pending.id),
      'operator',
      abort.signal,
    );
    expect(result.status).toBe('verification_pending');
    expect(f.operations.get(pending.id)).toEqual(pending);
  } finally {
    f.close();
  }
});
it('cannot reconstruct an existing operation with another service owner', async () => {
  const f = await fixture();
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    const other = new SealedPublicationService({
      authority: f.authority,
      operations: f.operations,
      artifact: f.artifact,
      credentialCustodianRegistered: true,
    });
    expect(other.recoveryCandidates('session', 'review', 'a'.repeat(64))).toEqual([]);
    await expect(
      other.recoverExact(recoverySelection(f, pending.id), 'operator', f.signal),
    ).rejects.toThrow('Retained exact recovery unavailable');
    expect(f.run.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(1);
  } finally {
    f.close();
  }
});
it('never lends fresh observer authority to an already-running ordinary recovery', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.loseResponse();
    const pending = await f.service.invoke(f.input, f.signal, async () => true);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.run.getMockImplementation()!;
    let users = 0;
    f.run.mockImplementation(async (command, args) => {
      // Initial invoke authorization is the first /user; the recovery executor owns
      // the existing in-flight claim before its second authority read.
      if (args.includes('/user') && ++users === 2) {
        entered();
        await hold;
      }
      return original(command, args);
    });
    const ordinary = f.service.invoke(f.input, f.signal, async () => {
      throw Error('No new approval');
    });
    await waiting;
    f.operators.delete('operator');
    f.operators.add('fresh');
    const before = f.run.mock.calls.length;
    await expect(
      f.service.recoverExact(recoverySelection(f, pending.id), 'fresh', f.signal),
    ).rejects.toThrow('Exact pending recovery unavailable');
    expect(f.run).toHaveBeenCalledTimes(before);
    release();
    expect((await ordinary).status).toBe('verification_pending');
    expect(f.operations.get(pending.id)?.status).toBe('verification_pending');
  } finally {
    release?.();
    f.close();
  }
});
