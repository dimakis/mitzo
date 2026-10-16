import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRegistry, onPermissionLifecycle, resolvePending } from '@mitzo/harness';
import type { PermissionRequest } from '@mitzo/protocol';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';

const mocks = vi.hoisted(() => ({ runtime: null as unknown }));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    catalog: () => [
      { id: 'personal', label: 'Personal ChatGPT' },
      { id: 'work', label: 'Work' },
    ],
  }),
}));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => mocks.runtime }));
vi.mock('../repository-workspace-runtime.js', () => ({
  repositoryWorkspacesEnabled: () => true,
  repositoryWorkspaceBinding: (accountId: string, model: string) => ({
    accountId,
    model,
    provider: 'openai-codex',
    profileRevision: '1',
  }),
  repositoryWorkspaceCatalog: vi.fn(),
  getRepositoryWorkspaces: vi.fn(),
}));
import { sessionRepositoryTools } from '../repository-chat-tools.js';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  mocks.runtime = null;
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function fixture(prefix = '') {
  const root = mkdtempSync(join(tmpdir(), 'chat-repository-access-'));
  const store = new ConnectionStore(join(root, 'connections.db'));
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = store.create({
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'Shared GitHub',
    endpoint: 'https://api.github.com',
    publicConfig: { allowedRepositories: ['example/existing'], allowedBaseBranches: ['main'] },
    gatewayProviderName: 'mitzo-conn-github',
    desiredAccountIds: ['personal', 'work'],
  });
  const connection = store.transition(
    created.id,
    created.revision,
    { status: 'active', gatewayProviderId: 'provider-id', identity: 'example', verifiedAt: 10 },
    { actor: 'operator', operation: 'provision', outcome: 'success' },
  );
  const gateway = {
    get: vi.fn(async () => ({
      id: 'provider-id',
      name: connection.gatewayProviderName,
      type: 'github',
      workspace: 'default',
      credentialKeys: ['GITHUB_TOKEN'],
    })),
    validateBinding: vi.fn(),
  };
  const service = new ConnectionsService(store, gateway as never);
  const runtime = { store, service };
  mocks.runtime = runtime;
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('client', {
    sessionId: 'chat',
    mode: 'auto',
    sessionAllowList: new Set(),
    worktreePaths: new Map(),
    observers: new Set(),
    transport: { isOpen: () => true, send: () => {} },
    abortController: new AbortController(),
    accountBinding: {
      accountId: 'personal',
      model: 'offline-fixture',
      provider: 'openai-codex',
      profileRevision: '1',
    },
    model: 'offline-fixture',
  } as never);
  const session = registry.get('client')!;
  session.sessionAllowList.add(prefix || 'RequestRepositoryAccess');
  const controller = new AbortController();
  const tools = sessionRepositoryTools('chat', session, registry, prefix);
  let review!: PermissionRequest;
  let prompted!: () => void;
  const prompt = new Promise<void>((resolve) => {
    prompted = resolve;
  });
  cleanups.push(
    onPermissionLifecycle((event) => {
      if (event.type === 'requested' && event.request.sessionId === 'chat') {
        review = event.request;
        prompted();
      }
    }),
  );
  const run = (
    input: Record<string, unknown> = { repository: 'https://github.com/Example/New.git' },
  ) => tools.execute('RequestRepositoryAccess', input, controller.signal);
  const decide = async (decision: 'once' | 'deny' = 'once', change?: () => void) => {
    const result = run();
    await prompt;
    expect(store.get(connection.id)).toEqual(connection);
    change?.();
    resolvePending(review.permId, decision, undefined, 'chat');
    return { result: await result, review };
  };
  return {
    store,
    connection,
    gateway,
    service,
    runtime,
    registry,
    session,
    controller,
    tools,
    run,
    decide,
    prompt,
    review: () => review,
  };
}

it.each(['', 'mcp__mitzo-connections__'])(
  'forces an exact request confirmation in Auto despite existing %s grants, then commits the audited addition',
  async (prefix) => {
    const f = fixture(prefix);
    const { result, review } = await f.decide();
    expect(review).toMatchObject({
      toolName: prefix + 'RequestRepositoryAccess',
      approvalScope: 'request',
      title: 'Add example/new to GitHub access?',
    });
    expect(review.description).toContain('Personal ChatGPT, Work');
    expect(review.description).toContain('main');
    expect(review.description).toContain('separate approval');
    expect(result?.isError).toBe(false);
    expect(f.store.get(f.connection.id)).toMatchObject({
      revision: f.connection.revision + 1,
      gatewayProviderId: 'provider-id',
      desiredAccountIds: ['personal', 'work'],
      publicConfig: {
        allowedRepositories: ['example/existing', 'example/new'],
        allowedBaseBranches: ['main'],
      },
    });
    expect(f.store.audit(f.connection.id).at(-1)).toMatchObject({
      operation: 'github_repository',
      actor: 'operator',
      affectedRefs: ['example/new'],
    });
    expect(f.session.sessionAllowList.size).toBe(1);
  },
);

it('leaves the shared connection unchanged when the user declines', async () => {
  const f = fixture();
  expect((await f.decide('deny')).result?.isError).toBe(true);
  expect(f.gateway.get).not.toHaveBeenCalled();
  expect(f.store.get(f.connection.id)).toEqual(f.connection);
});

it.each(['account', 'model', 'runtime', 'connection', 'owner', 'mode', 'skill', 'cancel'])(
  'refuses approval when %s changes during confirmation',
  async (kind) => {
    const f = fixture();
    const { result } = await f.decide('once', () => {
      if (kind === 'account') f.session.accountBinding!.accountId = 'other';
      if (kind === 'model') f.session.model = 'other';
      if (kind === 'runtime') mocks.runtime = { ...f.runtime };
      if (kind === 'connection')
        f.store.transition(
          f.connection.id,
          f.connection.revision,
          { identity: 'changed' },
          { actor: 'operator', operation: 'fixture', outcome: 'changed' },
        );
      if (kind === 'owner')
        f.registry.register('client', {
          sessionId: 'chat',
          mode: 'auto',
          abortController: new AbortController(),
        } as never);
      if (kind === 'mode') f.session.mode = 'ask';
      if (kind === 'skill') f.session.activeSkillPolicy = new Set(['ListRepositories']);
      if (kind === 'cancel') f.controller.abort();
    });
    expect(result?.isError).toBe(true);
    expect(f.gateway.get).not.toHaveBeenCalled();
    expect(f.store.get(f.connection.id)!.publicConfig.allowedRepositories).toEqual([
      'example/existing',
    ]);
  },
);

it('rechecks authority while the gateway lookup is pending, before committing consent', async () => {
  const f = fixture();
  let finish!: () => void;
  let lookedUp!: () => void;
  const lookup = new Promise<void>((resolve) => {
    lookedUp = resolve;
  });
  f.gateway.get.mockImplementationOnce(async () => {
    lookedUp();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      id: 'provider-id',
      name: f.connection.gatewayProviderName,
      type: 'github',
      workspace: 'default',
      credentialKeys: ['GITHUB_TOKEN'],
    };
  });
  const result = f.run();
  await f.prompt;
  resolvePending(f.review().permId, 'once', undefined, 'chat');
  await lookup;
  f.session.accountBinding!.accountId = 'other';
  finish();
  expect((await result)?.isError).toBe(true);
  expect(f.store.get(f.connection.id)).toEqual(f.connection);
});

it('returns existing authorization without a confirmation or a new revision', async () => {
  const f = fixture();
  expect(await f.run({ repository: 'example/existing' })).toMatchObject({ isError: false });
  expect(f.review()).toBeUndefined();
  expect(f.store.get(f.connection.id)).toEqual(f.connection);
});

it.each([
  'ask',
  'missing-runtime',
  'unassigned',
  'invalid-url',
  'forged-account',
  'forged-connection',
])('rejects %s before asking the user', async (kind) => {
  const f = fixture();
  if (kind === 'ask') f.session.mode = 'ask';
  if (kind === 'missing-runtime') mocks.runtime = null;
  if (kind === 'unassigned') f.session.accountBinding!.accountId = 'other';
  const input = {
    repository: kind === 'invalid-url' ? 'https://evil.test/example/new' : 'example/new',
    ...(kind === 'forged-account' ? { accountId: 'work' } : {}),
    ...(kind === 'forged-connection' ? { connectionId: f.connection.id } : {}),
  };
  expect((await f.run(input))?.isError).toBe(true);
  expect(f.review()).toBeUndefined();
  expect(f.gateway.get).not.toHaveBeenCalled();
  expect(f.store.get(f.connection.id)).toEqual(f.connection);
});
