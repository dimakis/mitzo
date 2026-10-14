import { afterEach, expect, it, vi } from 'vitest';
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
  canResumeOwnedOpenShellCodexDriver: () => false,
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
import { ordinaryCodexContinuationStatus } from '../ordinary-codex-continuation-status.js';
afterEach(() => vi.unstubAllEnvs());
function setup() {
  f.uncertain = false;
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
  f.session = { mode: 'agent' };
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
