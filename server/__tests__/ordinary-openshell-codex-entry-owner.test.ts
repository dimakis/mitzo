import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import {
  createOrdinaryOpenShellCodexEntryOwner,
  ordinaryOpenShellCodexContractRevision,
  loadOrdinaryOpenShellCodexTarget,
} from '../ordinary-openshell-codex-entry-owner.js';
import { verifiedOpenShellSeed } from '../openshell-runtime.js';
import type { OrdinaryOpenShellCodexOwnedRuntime } from '../ordinary-openshell-codex-owned-runtime.js';
import type { OrdinaryOpenShellCodexExpectation } from '../owned-openshell-codex-chat-admission.js';
const boundaries = vi.hoisted(() => ({
  config: undefined as OpenShellRuntimeConfig | undefined,
  owner: undefined as
    ConstructorParameters<typeof OrdinaryOpenShellCodexOwnedRuntime>[0] | undefined,
  account: {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai' as const,
    profileRevision: 'profile-r1',
    model: 'offline-model',
  },
  order: [] as string[],
  identity: vi.fn(),
  ready: vi.fn(async () => {}),
  provider: vi.fn(async () => {}),
  route: vi.fn(() => ({ kind: 'api', provider: 'provider' })),
  seed: vi.fn(async () => {}),
  workspace: { state: 'ready', baseOid: 'base', sourceDigest: 'source', sourceReleased: false },
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: () => boundaries.account,
    apiRoutingProfile: () => ({ sandboxProviderId: 'provider-id' }),
  }),
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'operator-session' } }),
}));
vi.mock('../agent-context-authority.js', () => ({
  retainAgentContextAuthority: () => ({ assertCurrent: boundaries.identity, release() {} }),
}));
vi.mock('../agent-library-runtime.js', () => ({ getAgentLibrary: () => ({}) }));
vi.mock('../ordinary-codex-agent-profile.js', () => ({
  readOrdinaryCodexAgentProfile: () => ({ definition: {} }),
}));
vi.mock('../ordinary-codex-agent-context.js', () => ({ assertOrdinaryCodexContextIdentity() {} }));
vi.mock('../session-permission-revision.js', () => ({ permissionRevision: () => 0 }));
vi.mock('../repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: () => ({
    get: () => ({ ...boundaries.workspace, binding: boundaries.account }),
    startupSeed: boundaries.seed,
  }),
}));
vi.mock('../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({ assertReady: boundaries.ready }),
}));
vi.mock('../ordinary-openshell-codex-route.js', async (original) => ({
  ...(await original<object>()),
  projectOrdinaryOpenShellCodexCapabilities: () => ({
    catalog: { targets: [] },
    inventory: { accounts: [{ account: boundaries.account }] },
  }),
  assertOrdinaryOpenShellCodexRoute: boundaries.route,
}));
vi.mock('../ordinary-openshell-codex-owned-runtime.js', () => ({
  OrdinaryOpenShellCodexOwnedRuntime: class {
    constructor(owner: NonNullable<typeof boundaries.owner>) {
      boundaries.owner = owner;
    }
  },
}));
vi.mock('../openshell-runtime.js', async (original) => ({
  ...(await original<typeof import('../openshell-runtime.js')>()),
  openShellRuntimeConfig: () => boundaries.config,
  // Seed qualification is separately covered by the existing runtime stack tests.
  verifiedOpenShellSeed: vi.fn((config) => config.seed),
  OpenShellRuntimeManager: class {
    verifyAPIAccountProvider = boundaries.provider;
  },
}));
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  boundaries.config = undefined;
  boundaries.owner = undefined;
  boundaries.order = [];
  boundaries.workspace.state = 'ready';
  vi.clearAllMocks();
  boundaries.identity.mockReset();
  boundaries.ready.mockReset();
  boundaries.provider.mockReset();
  boundaries.seed.mockReset();
  vi.unstubAllEnvs();
});

function ownerFixture() {
  const f = fixture();
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE', f.selector);
  createOrdinaryOpenShellCodexEntryOwner({
    events: {} as never,
    nativeStore: { hasConversation: () => false } as never,
    account: boundaries.account,
    sessionId: 'session',
    workspaceId: 'workspace',
    taskRoot: f.root,
    operatorConnectionId: 'operator',
    signal: new AbortController().signal,
    readRetained: () => undefined,
    dispatch: vi.fn(),
    dispatchContinuation: vi.fn(),
    close: vi.fn(),
  });
  const expected = {
    binding: { account: boundaries.account },
    agentProfile: { definition: {} },
    selection: { permission: { revision: 0 } },
  } as unknown as OrdinaryOpenShellCodexExpectation;
  boundaries.provider.mockImplementation(async () => {
    boundaries.order.push('provider');
  });
  boundaries.ready.mockImplementation(async () => {
    boundaries.order.push('ready');
  });
  return { expected, owner: boundaries.owner! };
}

it('qualifies the read-only provider before one fresh readiness check per operation', async () => {
  const { owner, expected } = ownerFixture();
  await owner.assertCurrent(expected);
  await owner.assertCurrent(expected);
  expect(boundaries.order).toEqual(['provider', 'ready', 'provider', 'ready']);
  expect(boundaries.ready).toHaveBeenCalledTimes(2);
  // Three identity/route fences per operation: before provider observation,
  // before workspace startup, and after its possible asynchronous work.
  expect(boundaries.route).toHaveBeenCalledTimes(6);
});

it.each(['unavailable', 'rotation', 'revocation'])(
  'rejects %s at final readiness before workspace startup',
  async (kind) => {
    const { owner, expected } = ownerFixture();
    boundaries.workspace.state = 'claimed';
    Object.assign(boundaries.workspace, { conversationId: 'session', sandbox: true });
    const unavailable = async () => {
      boundaries.order.push('ready');
      throw Error(kind);
    };
    if (kind === 'unavailable') boundaries.ready.mockImplementation(unavailable);
    else
      boundaries.provider.mockImplementation(async () => {
        boundaries.order.push('provider');
        boundaries.ready.mockImplementation(unavailable);
      });
    await expect(owner.assertCurrent(expected)).rejects.toThrow(kind);
    expect(boundaries.order).toEqual(['provider', 'ready']);
    expect(boundaries.seed).not.toHaveBeenCalled();
  },
);

it('rejects provider identity drift without entering workspace startup', async () => {
  const { owner, expected } = ownerFixture();
  boundaries.provider.mockRejectedValueOnce(Error('provider changed'));
  await expect(owner.assertCurrent(expected)).rejects.toThrow('provider changed');
  expect(boundaries.ready).not.toHaveBeenCalled();
  expect(boundaries.seed).not.toHaveBeenCalled();
});

it('keeps the final identity fence after workspace startup', async () => {
  const { owner, expected } = ownerFixture();
  boundaries.workspace.state = 'claimed';
  Object.assign(boundaries.workspace, { conversationId: 'session', sandbox: true });
  boundaries.seed.mockImplementation(async () => {
    boundaries.order.push('seed');
    boundaries.identity.mockImplementation(() => {
      throw Error('operator revoked during seed');
    });
  });
  await expect(owner.assertCurrent(expected)).rejects.toThrow('operator revoked during seed');
  expect(boundaries.order).toEqual(['provider', 'ready', 'seed']);
});

it('rejects identity revocation during provider observation before workspace startup', async () => {
  const { owner, expected } = ownerFixture();
  boundaries.provider.mockImplementation(async () => {
    boundaries.identity.mockImplementation(() => {
      throw Error('operator revoked');
    });
  });
  await expect(owner.assertCurrent(expected)).rejects.toThrow('operator revoked');
  expect(boundaries.seed).not.toHaveBeenCalled();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-openshell-target-')));
  roots.push(root);
  const cli = join(root, 'openshell');
  const policy = join(root, 'policy.yaml');
  const selector = join(root, 'target.json');
  const binary = Buffer.concat([
    Buffer.from('cffaedfe', 'hex'),
    Buffer.from('offline fixture, never executed'),
  ]);
  writeFileSync(cli, binary, { mode: 0o700 });
  writeFileSync(policy, 'version: 1\n', { mode: 0o600 });
  boundaries.config = {
    cli,
    image: 'fixture-image',
    policy,
    seed: join(root, 'seed'),
    seedStackManifest: {
      policy: { sha256: createHash('sha256').update(readFileSync(policy)).digest('hex') },
    },
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'workspace',
    gateway: 'gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 24,
    workdir: '/sandbox/workspaces/task',
    webSearch: 'disabled',
  };
  const contract = ordinaryOpenShellCodexContractRevision(
    boundaries.config,
    createHash('sha256').update(binary).digest('hex'),
  );
  writeFileSync(
    selector,
    JSON.stringify({
      version: 1,
      targetId: 'target',
      runtimeContractRevision: contract,
      openaiApi: 'disabled',
    }),
    { mode: 0o600 },
  );
  return {
    root,
    cli,
    policy,
    selector,
    env: { MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE: selector },
  };
}
it('reads one private explicit selector and measured reviewed runtime without allocating a resource', () => {
  const f = fixture();
  expect(loadOrdinaryOpenShellCodexTarget(f.env)?.target).toMatchObject({
    targetId: 'target',
    location: 'openshell',
  });
  expect(loadOrdinaryOpenShellCodexTarget({})).toBeUndefined();
});
it.each(['permissions', 'symlink', 'parent', 'contract', 'binary', 'policy', 'legacy'])(
  'rejects %s selector/runtime drift',
  (kind) => {
    const f = fixture();
    if (kind === 'permissions') chmodSync(f.selector, 0o644);
    if (kind === 'symlink') {
      const link = join(f.root, 'selector-link');
      symlinkSync(f.selector, link);
      f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE = link;
    }
    if (kind === 'parent') {
      const link = join(f.root, 'parent-link');
      symlinkSync(f.root, link);
      f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE = join(link, 'target.json');
    }
    if (kind === 'contract')
      writeFileSync(
        f.selector,
        JSON.stringify({
          version: 1,
          targetId: 'target',
          runtimeContractRevision: 'arbitrary-label',
          openaiApi: 'disabled',
        }),
      );
    if (kind === 'binary')
      writeFileSync(
        f.cli,
        Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('changed executable bytes')]),
      );
    if (kind === 'policy') writeFileSync(f.policy, 'version: 2\n');
    if (kind === 'legacy') Object.assign(f.env, { MITZO_OPENSHELL_SANDBOX_NAME: 'shared-sandbox' });
    expect(() => loadOrdinaryOpenShellCodexTarget(f.env)).toThrow('entry unavailable');
  },
);

it('discovers the runtime target without rescanning publication contents at every identity fence', () => {
  const f = fixture();
  const verifySeed = vi.mocked(verifiedOpenShellSeed);
  verifySeed.mockClear();
  verifySeed.mockImplementationOnce(() => {
    throw Error('Publication payload verification belongs to seed upload');
  });
  expect(loadOrdinaryOpenShellCodexTarget(f.env)?.target.targetId).toBe('target');
  expect(loadOrdinaryOpenShellCodexTarget(f.env)?.target.targetId).toBe('target');
  expect(verifySeed).not.toHaveBeenCalled();
  verifySeed.mockReset();
});
