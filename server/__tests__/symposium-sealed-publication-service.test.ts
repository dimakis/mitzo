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
) {
  const scope: SealedPublicationScope = {
    operatorId: 'operator',
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
  const authority = new SealedPublicationAuthority(':memory:', {
    assertOperator: () => true,
    assertArtifact: async () => {},
    resolveCredential: () => (current ? handle : null),
  });
  const grant = await authority.grant(
    scope,
    { host: 'github.com', numericId: 42, login: 'selected-user' },
    signal,
  );
  const operations = new CapabilityOperationStore(':memory:');
  const exportBundle = vi.fn(async () => Buffer.from('mocked git bundle'));
  const artifact = {
    require: async () => ({ workspace: '/artifact', repositoryPath: '/artifact', sourceOid: oid }),
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
    operations,
    service,
    input,
    signal,
    run,
    exportBundle,
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
