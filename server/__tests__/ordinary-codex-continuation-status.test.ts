import { afterEach, expect, it, vi } from 'vitest';
import { login, authenticateToken, revokeAuthSession } from '../auth.js';
import { AccountProfiles } from '../account-profiles.js';
import {
  OrdinaryLocalCodexTarget,
  OrdinaryLocalCodexCapabilityCatalog,
} from '../ordinary-local-codex-capabilities.js';
const f = vi.hoisted(() => ({
  session: undefined as unknown,
  binding: undefined as unknown,
  live: undefined as unknown,
  target: undefined as unknown,
  profiles: undefined as unknown,
  resume: vi.fn(),
  uncertain: false,
  untransferred: vi.fn(() => false),
  custody: 'original' as string | undefined,
  openshell: undefined as unknown,
  openshellResume: vi.fn(),
  continuationTarget: vi.fn(),
  blocker: undefined as undefined | { commandId: string; kind: string },
  reconcile: vi.fn(),
}));
vi.mock('../retained-local-codex-effects.js', () => ({
  reconcilableLocalCodexCommand: f.reconcile,
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexConversationStore: () => ({
    readHostCustody: () => ({ authSessionId: f.custody }),
    continuationBlocker: () => f.blocker,
  }),
}));
vi.mock('../repository-workspace-runtime.js', () => ({ getRepositoryWorkspaces: () => ({}) }));
vi.mock('../owned-prepared-repository-transition.js', () => ({
  canResumeUntransferredPreparedRepository: f.untransferred,
}));
vi.mock('../chat.js', () => ({
  eventStore: {
    getSession: () => f.session,
    getSessionRuntimeBinding: () => f.binding,
    hasUncertainOrdinaryCommand: () => f.uncertain,
  },
  registry: { findBySessionId: () => f.live },
  canResumeOwnedLocalCodexDriver: f.resume,
}));
vi.mock('../ordinary-openshell-codex-entry.js', () => ({
  canResumeOwnedOpenShellCodexDriver: f.openshellResume,
  ownedOpenShellCodexContinuationTarget: f.continuationTarget,
}));
vi.mock('../account-profiles.js', async (orig) => ({
  ...(await orig<object>()),
  loadAccountProfiles: () => f.profiles,
}));
vi.mock('../ordinary-local-codex-capabilities.js', async (orig) => ({
  ...(await orig<object>()),
  loadOrdinaryLocalCodexTarget: () => f.target,
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerMode: false,
  custodianOwnerMode: false,
}));
vi.mock('../ordinary-openshell-codex-entry-owner.js', () => ({
  loadOrdinaryOpenShellCodexTarget: () => f.openshell,
}));
import { ordinaryOpenShellCodexTarget } from '../ordinary-openshell-codex-route.js';
import { ordinaryCodexContinuationStatus } from '../ordinary-codex-continuation-status.js';
afterEach(() => vi.unstubAllEnvs());
function setup() {
  f.reconcile.mockReset().mockReturnValue(undefined);
  f.blocker = undefined;
  f.uncertain = false;
  f.untransferred.mockReset().mockReturnValue(false);
  f.custody = 'original';
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  f.profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: '/offline/login',
        email: 'fixture@example.test',
        planType: 'plus',
        models: [{ id: 'offline', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  f.target = new OrdinaryLocalCodexTarget({
    version: 1,
    targetId: 'mac',
    label: 'Local Mac',
    hostId: 'fixture',
    runtimeContractRevision: 'contract',
  });
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    f.profiles as AccountProfiles,
    f.target as OrdinaryLocalCodexTarget,
    'ordinary',
  );
  const result = catalog.resolve({
    account: catalog.inventory().accounts[0].account,
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  });
  if (result.status !== 'compatible') throw Error('fixture');
  f.binding = result.binding;
  f.session = {
    mode: 'agent',
    accountBinding: (f.profiles as AccountProfiles).resolve('personal', 'offline'),
  };
  f.live = undefined;
  f.resume.mockReset().mockReturnValue(false);
}
it('exposes a same-login live action without claiming provider readiness', () => {
  setup();
  f.live = { session: { ordinaryRuntimeOwner: { location: 'local', authSessionId: 'original' } } };
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toEqual({ available: true });
  expect(f.resume).not.toHaveBeenCalled();
});
it('requires retained custody for cold execution while preserving saved metadata', () => {
  setup();
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('custody'),
  });
  f.resume.mockReturnValue(true);
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toEqual({ available: true });
});
it('explains original callback effects before expensive runtime qualification or a speculative resume', () => {
  setup();
  (f.session as Record<string, unknown>).accountBinding = { accountId: 'original' };
  f.blocker = { commandId: 'completed-once', kind: 'tool_effects' };
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('unresolved tool or completion effects'),
  });
  expect(f.resume).not.toHaveBeenCalled();
});
it('offers Send for qualified cold reconciliation without requiring a separate continue action', () => {
  setup();
  f.blocker = { commandId: 'original-turn', kind: 'completion_phase' };
  f.reconcile.mockReturnValue('original-turn');
  f.resume.mockReturnValue(true);
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toEqual({ available: true });
  expect(f.reconcile).toHaveBeenCalledOnce();
  expect(f.blocker).toEqual({ commandId: 'original-turn', kind: 'completion_phase' });
});
it('refuses disabled, changed and foreign routes before execution support', () => {
  setup();
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '0');
  expect(ordinaryCodexContinuationStatus('conversation', 'original').available).toBe(false);
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  f.target = new OrdinaryLocalCodexTarget({
    version: 1,
    targetId: 'mac',
    label: 'Local Mac',
    hostId: 'fixture',
    runtimeContractRevision: 'changed',
  });
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('changed'),
  });
  expect(f.resume).not.toHaveBeenCalled();
  setup();
  f.live = { session: { ordinaryRuntimeOwner: { location: 'local', authSessionId: 'other' } } };
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('another login'),
  });
});
it('requires interactive original authorization and never infers a legacy route', () => {
  setup();
  expect(ordinaryCodexContinuationStatus('conversation')).toMatchObject({
    available: false,
    reason: expect.stringContaining('Sign in'),
  });
  f.binding = null;
  expect(ordinaryCodexContinuationStatus('legacy', 'original')).toEqual({ available: false });
  expect(f.resume).not.toHaveBeenCalled();
});

it('explains an unresolved dispatch without enabling a replacement command', () => {
  setup();
  f.uncertain = true;
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('unconfirmed dispatch'),
  });
  expect(f.resume).not.toHaveBeenCalled();
});

it('offers a fresh cold resume for the exact untransferred repository reservation without clearing it', () => {
  setup();
  f.uncertain = true;
  f.untransferred.mockReturnValue(true);
  f.resume.mockReturnValue(true);
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toEqual({ available: true });
  expect(f.untransferred).toHaveBeenCalledOnce();
  expect(f.uncertain).toBe(true);
  f.blocker = { commandId: 'source', kind: 'tool_effects' };
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('unresolved tool or completion effects'),
  });
  f.blocker = undefined;
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '0');
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toMatchObject({
    available: false,
    reason: expect.stringContaining('not enabled'),
  });
});
it('does not inspect a prepared reservation for a foreign login or live owner', () => {
  setup();
  f.uncertain = true;
  f.untransferred.mockReturnValue(true);
  expect(ordinaryCodexContinuationStatus('conversation', 'foreign').available).toBe(false);
  expect(f.untransferred).not.toHaveBeenCalled();
  f.live = { session: { ordinaryRuntimeOwner: { location: 'local', authSessionId: 'original' } } };
  expect(ordinaryCodexContinuationStatus('conversation', 'original').available).toBe(false);
  expect(f.untransferred).not.toHaveBeenCalled();
});

it('offers continuation for an upgraded OpenShell chat only through the original native custody', async () => {
  setup();
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  const profiles = new AccountProfiles([
    {
      id: 'work',
      label: 'Work',
      provider: 'openai',
      credentialRef: { provider: 'offline', service: 'offline', account: 'offline' },
      sandboxProvider: 'work',
      sandboxProviderId: 'work-id',
      models: [{ id: 'offline', label: 'Offline' }],
    },
  ]);
  f.profiles = profiles;
  const config = {
    cli: '/offline/cli',
    image: 'new-image',
    policy: '/release/new/policy',
    seed: '/release/new/seed',
    workspace: 'work',
    gateway: 'gateway',
    workdir: '/sandbox/workspaces/task',
    gatewayInsecure: false,
    serviceProviders: [],
    grantableServiceProviders: [],
    webSearch: 'disabled' as const,
    createDetached: true,
    sandboxIdLength: 13,
  };
  const target = ordinaryOpenShellCodexTarget({
    targetId: 'openshell',
    runtimeContractRevision: 'new-release',
    openaiApi: 'enabled',
    config,
  });
  f.openshell = { config, target };
  f.binding = {
    version: 2,
    account: {
      accountId: 'work',
      provider: 'openai',
      profileRevision: profiles.resolve('work', 'offline').profileRevision,
    },
    harness: { implementation: 'codex' },
    execution: { location: 'openshell', targetId: 'openshell', targetRevision: 'original-release' },
  };
  f.continuationTarget
    .mockReset()
    .mockReturnValue({ ...target, targetRevision: 'original-release' });
  f.openshellResume.mockReturnValue(true);
  expect(ordinaryCodexContinuationStatus('conversation', 'original')).toEqual({ available: true });
  expect(f.continuationTarget).toHaveBeenCalledWith('conversation', 'original', f.openshell);
  const actor = await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!);
  if (!actor) throw Error('Fixture login failed');
  try {
    f.live = {
      session: { ordinaryRuntimeOwner: { location: 'openshell', authSessionId: 'original' } },
    };
    expect(ordinaryCodexContinuationStatus('conversation', actor.id)).toEqual({ available: true });
    revokeAuthSession(actor);
    expect(ordinaryCodexContinuationStatus('conversation', actor.id).available).toBe(false);
  } finally {
    revokeAuthSession(actor);
    f.live = undefined;
  }
  f.continuationTarget.mockImplementation(() => {
    throw Error('foreign custody');
  });
  expect(ordinaryCodexContinuationStatus('conversation', 'original').available).toBe(false);
});
