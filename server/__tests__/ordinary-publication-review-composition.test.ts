import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';

const mocks = vi.hoisted(() => ({
  executorDependencies: undefined as unknown,
  reconstruct: vi.fn(),
  push: vi.fn(),
  cleanup: vi.fn(),
  authCurrent: true,
}));
vi.mock('../connections/capabilities/github-publish-pr.js', async (original) => {
  const actual =
    await original<typeof import('../connections/capabilities/github-publish-pr.js')>();
  return {
    ...actual,
    createGithubArtifactPublishPrExecutor: (
      deps: Parameters<typeof actual.createGithubArtifactPublishPrExecutor>[0],
    ) => {
      mocks.executorDependencies = deps;
      return actual.createGithubArtifactPublishPrExecutor(deps);
    },
  };
});
vi.mock('../agent-library-transport.js', async (original) => ({
  ...(await original<typeof import('../agent-library-transport.js')>()),
  captureAgentLibraryAuthorization: () => ({
    auth: { id: 'publisher-auth' },
    assertCurrent: () => {
      if (!mocks.authCurrent) throw Error('Publisher revoked');
    },
  }),
}));
vi.mock('../github-host-source.js', async (original) => ({
  ...(await original<typeof import('../github-host-source.js')>()),
  readHostGithubOrigin: async () => 'https://github.com/example/repo.git',
  exportHostGithubBundle: async () => Buffer.from('offline committed bundle'),
  inspectHostGithubRepository: async () => ({
    canonicalRepositoryPath: '/workspace',
    status: '',
    sourceBranch: 'feature/task',
    sourceOid: 'a'.repeat(40),
    defaultBranch: 'main',
    originUrl: 'https://github.com/example/repo.git',
    commitsAhead: 1,
    changedFiles: ['change.ts'],
    sourceBranchProtected: false,
    symlinkFree: true,
  }),
}));
vi.mock('../connections/capabilities/github-publish-pr-transport.js', async (original) => {
  const actual =
    await original<typeof import('../connections/capabilities/github-publish-pr-transport.js')>();
  const pull = {
    repository: 'example/repo',
    sourceBranch: 'feature/task',
    baseBranch: 'main',
    title: 'Publish work',
    body: 'Change',
    draft: true,
    id: '1',
    url: 'https://github.com/example/repo/pull/1',
  };
  return {
    ...actual,
    GitHubCliHostPublisher: class extends actual.GitHubCliHostPublisher {
      identity = async () => 'publisher';
      policy = async () => ({ defaultBranch: 'main', sourceBranchProtected: false });
      reconstruct = mocks.reconstruct;
      push = mocks.push;
      cleanup = mocks.cleanup;
      findOpen = async () => null;
      create = async () => pull;
      read = async () => pull;
      readBranch = async () => 'a'.repeat(40);
    },
  };
});
import { createConnectionsRuntime } from '../connections-runtime.js';
import { createGithubPublishingTool } from '../github-publishing-tool.js';
import {
  bindLiveCapabilityConversation,
  clearLiveCapabilityConversationBinding,
} from '../capability-conversation-binding.js';

it('publishes without model review and fences every ordinary capability entry point with retained authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-publication-composition-'));
  const session = {
    sessionId: 'conversation',
    ownerConnectionId: 'signed-publisher',
    mode: 'auto',
    accountBinding: { accountId: 'selected', provider: 'openai', profileRevision: 'one' },
    activeSkillPolicy: null,
  } as unknown as ManagedSession;
  const registry = {
    findBySessionId: () => ({ clientId: 'owner', session }),
    get: () => session,
  } as unknown as SessionRegistry;
  const runtime = createConnectionsRuntime({
    directory,
    cli: '/unavailable-offline-openshell',
    workspace: 'offline',
    eligibleAccountIds: () => ['selected'],
    githubPublishEnabled: true,
    resolveConversationBinding: () => session.accountBinding,
  });
  const created = runtime.store.create({
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'Offline publisher',
    endpoint: 'https://api.github.com',
    gatewayProviderName: 'offline-github',
    desiredAccountIds: ['selected'],
    publicConfig: { allowedRepositories: ['example/repo'], allowedBaseBranches: ['main'] },
  });
  const connection = runtime.store.transition(
    created.id,
    created.revision,
    {
      status: 'active',
      identity: 'publisher',
      gatewayProviderId: 'offline-github',
      verifiedAt: Date.now(),
    },
    { operation: 'provision', outcome: 'success', actor: 'operator' },
  );
  runtime.capabilities.setGrant({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: ['selected'],
    status: 'active',
  });
  runtime.capabilityStore.approveGithubRepository({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    accountId: 'selected',
    repository: 'example/repo',
  });
  let publisher = createGithubPublishingTool('conversation', registry, () => ({
    runtime: 'host',
    workspace: '/workspace',
    gitStorageRoots: [],
  }));
  const bindPublisher = () =>
    bindLiveCapabilityConversation('conversation', {
      runtime: 'host',
      workspace: '/workspace',
      runtimeOwnerId: publisher.runtimeOwnerId,
      accountId: 'selected',
      connectionId: connection.id,
      connectionRevision: connection.revision,
      gatewayProviderId: 'offline-github',
      gitStorageRoots: [],
    });
  bindPublisher();
  const request = (key: string) => ({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountId: 'selected',
    conversationId: 'conversation',
    turnId: key,
    idempotencyKey: key,
    input: {
      connectionId: connection.id,
      repositoryPath: '/workspace',
      baseBranch: 'main',
      title: 'Publish work',
      body: 'Change',
      draft: true,
    },
  });
  try {
    expect(mocks.executorDependencies).not.toHaveProperty('reviewCommittedChange');
    mocks.authCurrent = true;
    mocks.push.mockReset().mockResolvedValue(undefined);
    mocks.cleanup.mockReset().mockResolvedValue(undefined);
    mocks.reconstruct.mockReset().mockResolvedValue({ directory: '/private/offline-checkout' });
    const direct = await runtime.capabilities.invoke(
      request('http-no-callback'),
      new AbortController().signal,
      async () => true,
    );
    expect(direct.status).toBe('succeeded');
    const nativeCurrent = vi.fn(async () => {});
    const alias = await runtime.capabilities.invoke(
      request('dynamic-alias'),
      new AbortController().signal,
      async () => true,
      nativeCurrent,
    );
    expect(alias.status).toBe('succeeded');
    expect(nativeCurrent).toHaveBeenCalled();
    const pushed = mocks.push.mock.calls.length;
    for (const revoked of [
      'operator',
      'runtime',
      'native-call',
      'caller-await',
      'caller-sync',
    ] as const) {
      let callCurrent = true;
      let reconstructed = false;
      mocks.authCurrent = true;
      mocks.reconstruct.mockImplementationOnce(async () => {
        if (revoked === 'operator') mocks.authCurrent = false;
        if (revoked === 'runtime') {
          publisher.close();
          publisher = createGithubPublishingTool('conversation', registry, () => ({
            runtime: 'host',
            workspace: '/workspace',
            gitStorageRoots: [],
          }));
          bindPublisher();
        }
        if (revoked === 'native-call') callCurrent = false;
        reconstructed = true;
        return { directory: '/private/offline-checkout' };
      });
      const callerCurrent = ['native-call', 'caller-await', 'caller-sync'].includes(revoked)
        ? Object.assign(
            async () => {
              if (!callCurrent) throw Error('Native callback expired');
              if (reconstructed && revoked === 'caller-await') {
                await Promise.resolve();
                mocks.authCurrent = false;
              }
              if (reconstructed && revoked === 'caller-sync') {
                await Promise.resolve();
                callCurrent = false;
              }
            },
            {
              assertCurrentSync: () => {
                if (!callCurrent) throw Error('Native callback expired');
              },
            },
          )
        : undefined;
      const result = await runtime.capabilities.invoke(
        request(`revoke-${revoked}`),
        new AbortController().signal,
        async () => true,
        callerCurrent,
      );
      expect(result.status, revoked).toBe('failed');
      expect(mocks.push).toHaveBeenCalledTimes(pushed);
    }
    expect(mocks.cleanup).toHaveBeenCalledTimes(7);
    mocks.authCurrent = true;
    mocks.push.mockRejectedValueOnce(new Error('Lost push response'));
    const uncertainRequest = request('lost-response');
    const uncertain = await runtime.capabilities.invoke(
      uncertainRequest,
      new AbortController().signal,
      async () => true,
    );
    expect(uncertain.status).toBe('verification_pending');
    mocks.authCurrent = false;
    const previousPushes = mocks.push.mock.calls.length;
    const recovered = await runtime.capabilities.invoke(
      uncertainRequest,
      new AbortController().signal,
      async () => true,
    );
    expect(recovered.status).toBe('succeeded');
    expect(mocks.push).toHaveBeenCalledTimes(previousPushes);
    expect(mocks.cleanup).toHaveBeenCalledTimes(8);
  } finally {
    publisher.close();
    clearLiveCapabilityConversationBinding('conversation');
    runtime.store.close();
    runtime.capabilityStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
