import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import {
  OrdinaryLocalCodexTarget,
  OrdinaryLocalCodexCapabilityCatalog,
  loadOrdinaryLocalCodexTarget,
} from '../ordinary-local-codex-capabilities.js';

const boundaries = vi.hoisted(() => ({ cached: vi.fn(), launch: vi.fn(), refresh: vi.fn() }));
vi.mock('../model-catalog.js', async (original) => ({
  ...(await original<typeof import('../model-catalog.js')>()),
  cachedModels: boundaries.cached,
  refreshModels: boundaries.refresh,
}));
vi.mock('../codex-app-server-client.js', () => ({
  CodexAppServerClient: { launch: boundaries.launch, launchOpenShell: boundaries.launch },
}));

// Offline metadata fixtures; no inference calls or charged account.
const model = {
  id: 'fixture-model',
  label: 'Fixture model',
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'low',
};
const host = {
  id: 'host',
  label: 'Personal',
  provider: 'openai-codex',
  credentialRef: '/private/fixture-login',
  email: 'private@example.test',
  planType: 'pro',
  models: [model],
};
const targetConfig = {
  version: 1,
  targetId: 'local-mac',
  label: 'Local Mac',
  hostId: 'private-host-identity',
  runtimeContractRevision: 'reviewed-local-codex-r1',
};
const dirs: string[] = [];
function file(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-target-'));
  dirs.push(dir);
  const path = join(dir, 'target.json');
  writeFileSync(path, content);
  return path;
}
function profiles(config: unknown = [host], enabled = true) {
  return new AccountProfiles(config, { codexEnabled: enabled });
}
function snapshot(config: unknown = targetConfig, accounts: AccountProfiles = profiles()) {
  return new OrdinaryLocalCodexCapabilityCatalog(
    accounts,
    new OrdinaryLocalCodexTarget(config),
    'ordinary',
  );
}
function request(p: AccountProfiles = profiles(), targetId = 'local-mac') {
  const { accountId, provider, profileRevision } = p.ordinaryLocalCodexAccounts()[0];
  return {
    account: { accountId, provider, profileRevision },
    targetId,
    harness: 'codex',
    mode: 'agent',
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  boundaries.cached.mockReset();
});

describe('trusted dormant local target snapshot', () => {
  it('retains private immutable declarations for owning admission verification', () => {
    const input = structuredClone(targetConfig);
    const target = new OrdinaryLocalCodexTarget(input);
    const declaration = target.admissionDeclaration();
    expect(declaration).toEqual({
      targetId: targetConfig.targetId,
      targetRevision: target.descriptor().targetRevision,
      location: 'local',
      harness: 'codex',
      hostId: targetConfig.hostId,
      runtimeContractRevision: targetConfig.runtimeContractRevision,
    });
    input.hostId = 'mutated-input';
    declaration.hostId = 'mutated-copy';
    expect(target.admissionDeclaration().hostId).toBe(targetConfig.hostId);
    expect(JSON.stringify(target.descriptor())).not.toContain(targetConfig.hostId);
    expect(JSON.stringify(target)).not.toContain(targetConfig.runtimeContractRevision);
  });

  it('generates a routing digest without exposing host/runtime configuration', () => {
    const t = new OrdinaryLocalCodexTarget(targetConfig);
    expect(t.descriptor()).toEqual({
      targetId: 'local-mac',
      label: 'Local Mac',
      location: 'local',
      harness: 'codex',
      targetRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(t.descriptor())).not.toContain(targetConfig.hostId);
    expect(JSON.stringify(t.descriptor())).not.toContain(targetConfig.runtimeContractRevision);
    expect(JSON.stringify(t)).not.toContain(targetConfig.hostId);
  });
  it('keeps the target revision stable across presentation and key ordering', () => {
    const t = new OrdinaryLocalCodexTarget(targetConfig);
    const reordered = {
      label: 'Renamed',
      runtimeContractRevision: targetConfig.runtimeContractRevision,
      hostId: targetConfig.hostId,
      targetId: targetConfig.targetId,
      version: 1,
    };
    expect(new OrdinaryLocalCodexTarget(reordered).descriptor().targetRevision).toBe(
      t.descriptor().targetRevision,
    );
  });
  it.each([{ targetId: 'another' }, { hostId: 'another-host' }, { runtimeContractRevision: 'r2' }])(
    'changes the target pin for routing changes %j',
    (change) => {
      expect(
        new OrdinaryLocalCodexTarget({ ...targetConfig, ...change }).descriptor().targetRevision,
      ).not.toBe(new OrdinaryLocalCodexTarget(targetConfig).descriptor().targetRevision);
    },
  );
  it.each([
    undefined,
    null,
    {},
    { ...targetConfig, version: 2 },
    { ...targetConfig, targetId: ' two words ' },
    { ...targetConfig, hostId: '' },
    { ...targetConfig, runtimeContractRevision: 'x'.repeat(201) },
    { ...targetConfig, targetRevision: 'client-pin' },
    { ...targetConfig, location: 'openshell' },
    { ...targetConfig, credentialRef: '/DO-NOT-ECHO-secret' },
    { ...targetConfig, command: '/bin/custom' },
  ])('rejects invalid or expanded routing configuration %j', (config) => {
    expect(() => new OrdinaryLocalCodexTarget(config)).toThrow(
      'Invalid ordinary local Codex target configuration',
    );
  });
  it('retains an immutable validated snapshot and returns independent descriptors', () => {
    const input = structuredClone(targetConfig);
    const t = new OrdinaryLocalCodexTarget(input);
    const before = t.descriptor();
    input.hostId = 'changed';
    const returned = t.descriptor();
    returned.targetRevision = 'changed';
    expect(t.descriptor()).toEqual(before);
  });
});

describe('operator-selected bounded target loader', () => {
  it('is disabled without an explicit server file and never reads profile configuration', () => {
    expect(loadOrdinaryLocalCodexTarget({})).toBeUndefined();
    expect(
      loadOrdinaryLocalCodexTarget({ MITZO_ACCOUNT_PROFILES_FILE: '/not-a-target' }),
    ).toBeUndefined();
  });
  it('reads the explicit regular file and preserves constructor validation', () => {
    const path = file(JSON.stringify(targetConfig));
    expect(
      loadOrdinaryLocalCodexTarget({ MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: path })?.descriptor(),
    ).toEqual(new OrdinaryLocalCodexTarget(targetConfig).descriptor());
  });
  it.each(['', 'relative.json', '/DO-NOT-ECHO-missing', 'malformed', 'oversized', 'symlink'])(
    'fails closed with a finite non-sensitive error for %s',
    (kind) => {
      let path = kind;
      if (kind === 'malformed') path = file('{"DO-NOT-ECHO":"secret"');
      if (kind === 'oversized') path = file(' '.repeat(65537));
      if (kind === 'symlink') {
        const real = file(JSON.stringify(targetConfig));
        path = real + '.link';
        symlinkSync(real, path);
      }
      expect(() =>
        loadOrdinaryLocalCodexTarget({ MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: path }),
      ).toThrow('Invalid ordinary local Codex target configuration');
    },
  );
});

describe('bounded configuration-only capability snapshot', () => {
  it('requires explicit server deployment classification instead of defaulting to ordinary', () => {
    expect(
      () =>
        new OrdinaryLocalCodexCapabilityCatalog(
          profiles(),
          new OrdinaryLocalCodexTarget(targetConfig),
          undefined as unknown as 'ordinary',
        ),
    ).toThrow('Invalid ordinary local Codex capability inventory');
  });
  it('joins exact account/target pins and existing thinking metadata without assuming readiness', () => {
    const p = profiles();
    const c = snapshot(targetConfig, p);
    const inventory = c.inventory();
    expect(inventory).toMatchObject({
      version: 1,
      authority: 'configuration-only',
      defaultLocation: 'openshell',
      capabilityRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      accounts: [
        {
          account: request(p).account,
          label: 'Personal',
          models: [model],
          modelDiscovery: { source: 'configured', stale: false },
        },
      ],
      targets: [new OrdinaryLocalCodexTarget(targetConfig).descriptor()],
      locations: [
        { location: 'openshell', status: 'unavailable', reason: 'openshell_projection_pending' },
        { location: 'local', status: 'configured' },
      ],
      routes: [
        {
          account: request(p).account,
          targetId: 'local-mac',
          harness: 'codex',
          modes: ['ask', 'agent', 'auto'],
          skillCeiling: 'unsupported',
        },
      ],
    });
    expect(c.resolve(request(p))).toMatchObject({
      status: 'compatible',
      binding: { version: 2, execution: { targetRevision: inventory.targets[0].targetRevision } },
    });
    for (const secret of [
      host.credentialRef,
      host.email,
      targetConfig.hostId,
      targetConfig.runtimeContractRevision,
    ])
      expect(JSON.stringify(inventory)).not.toContain(secret);
  });
  it('uses existing cached discovery but never triggers a provider or refresh', () => {
    const discovered = { id: 'discovered', label: 'Discovered', reasoningEfforts: ['minimal'] };
    boundaries.cached.mockReturnValue({ models: [discovered], error: true, updatedAt: 123 });
    const c = snapshot();
    expect(c.inventory().accounts[0]).toMatchObject({
      models: [discovered],
      modelDiscovery: { source: 'cached', stale: true, updatedAt: 123 },
    });
    expect(boundaries.refresh).not.toHaveBeenCalled();
    expect(boundaries.launch).not.toHaveBeenCalled();
    boundaries.cached.mockReturnValue({ models: [model] });
    expect(c.inventory().accounts[0].models).toEqual([discovered]);
  });
  it('does not invent thinking values where discovery has none', () => {
    const c = snapshot(
      targetConfig,
      profiles([{ ...host, models: [{ id: 'plain', label: 'Plain' }] }]),
    );
    expect(c.inventory().accounts[0].models[0]).toEqual({ id: 'plain', label: 'Plain' });
  });
  it.each([false, true])(
    'keeps the OpenShell default without fallback when local target/account is absent (gate %s)',
    (enabled) => {
      const c = new OrdinaryLocalCodexCapabilityCatalog(
        profiles([host], enabled),
        undefined,
        'ordinary',
      );
      expect(c.inventory()).toMatchObject({
        defaultLocation: 'openshell',
        targets: [],
        routes: [],
        locations: [
          { location: 'openshell', status: 'unavailable' },
          { location: 'local', status: 'unavailable', reason: 'target_unconfigured' },
        ],
      });
    },
  );
  it('honors the Codex gate and rejects unknown accounts/targets through the existing resolver', () => {
    const c = snapshot(targetConfig, profiles([host], false));
    expect(c.inventory()).toMatchObject({
      accounts: [],
      routes: [],
      locations: [{ location: 'openshell' }, { location: 'local', reason: 'accounts_unavailable' }],
    });
    expect(c.resolve(request())).toEqual({ status: 'rejected', code: 'account_unavailable' });
    expect(snapshot().resolve({ ...request(), targetId: 'unconfigured' })).toEqual({
      status: 'rejected',
      code: 'target_unavailable',
    });
    expect(snapshot().resolve({ ...request(), targetRevision: 'client-pin' })).toEqual({
      status: 'rejected',
      code: 'invalid_request',
    });
  });
  it('excludes brokered/native/API profiles and refuses custodian host routes', () => {
    const broker = {
      ...host,
      id: 'broker',
      credentialRef: undefined,
      sandboxProvider: 'broker',
      sandboxProviderType: 'openai-codex-oauth',
      sandboxProviderId: 'provider',
      sandboxGrantId: 'grant',
    };
    const native = {
      ...host,
      id: 'native',
      credentialRef: undefined,
      nativeAuth: 'sandbox-chatgpt',
      sandboxProvider: 'native',
      sandboxProviderType: 'codex',
      sandboxProviderId: 'native-id',
    };
    const api = {
      id: 'api',
      label: 'API',
      provider: 'openai',
      credentialRef: {
        provider: 'keychain',
        service: 'private-service',
        account: 'private-account',
      },
      models: [model],
    };
    const p = profiles([host, broker, native, api]);
    const c = new OrdinaryLocalCodexCapabilityCatalog(
      p,
      new OrdinaryLocalCodexTarget(targetConfig),
      'custodian',
    );
    expect(c.inventory().accounts.map((a) => a.account.accountId)).toEqual(['host']);
    expect(c.inventory().routes).toEqual([]);
    expect(c.inventory().locations[1]).toMatchObject({
      status: 'unavailable',
      reason: 'custodian_requires_openshell',
    });
    expect(c.resolve(request(p))).toEqual({
      status: 'rejected',
      code: 'custodian_requires_dedicated_openshell',
    });
  });
  it('separates mutable model/effort capability revision from immutable target and account identity', () => {
    const before = snapshot();
    const after = snapshot(
      targetConfig,
      profiles([
        {
          ...host,
          models: [{ ...model, reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }],
        },
      ]),
    );
    expect(after.inventory().capabilityRevision).not.toBe(before.inventory().capabilityRevision);
    expect(after.inventory().targets).toEqual(before.inventory().targets);
    expect(after.inventory().accounts[0].account).toEqual(before.inventory().accounts[0].account);
    const rename = snapshot(
      { ...targetConfig, label: 'New target label' },
      profiles([
        { ...host, label: 'New account label', models: [{ ...model, label: 'Renamed model' }] },
      ]),
    );
    expect(rename.inventory().capabilityRevision).toBe(before.inventory().capabilityRevision);
  });
  it('changes capability identity on account rotation without changing the target', () => {
    const before = snapshot();
    const after = snapshot(
      targetConfig,
      profiles([{ ...host, credentialRef: '/private/rotated-fixture-login' }]),
    );
    expect(after.inventory().capabilityRevision).not.toBe(before.inventory().capabilityRevision);
    expect(after.inventory().targets).toEqual(before.inventory().targets);
    expect(after.resolve(request())).toEqual({
      status: 'rejected',
      code: 'account_identity_mismatch',
    });
  });
  it('does not invoke account authentication, general catalog or refresh while taking inventory', () => {
    const p = profiles();
    const catalog = vi.spyOn(p, 'catalog').mockImplementation(() => {
      throw new Error('General catalog is forbidden');
    });
    const resolve = vi.spyOn(p, 'resolve').mockImplementation(() => {
      throw new Error('Resolve is forbidden');
    });
    const refresh = vi.spyOn(p, 'refresh').mockImplementation(async () => {
      throw new Error('Refresh is forbidden');
    });
    const c = snapshot(targetConfig, p);
    expect(c.inventory().accounts).toHaveLength(1);
    expect(catalog).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(boundaries.launch).not.toHaveBeenCalled();
    expect(boundaries.refresh).not.toHaveBeenCalled();
  });
  it('hides errors from the existing metadata source behind the finite inventory error', () => {
    const p = profiles();
    vi.spyOn(p, 'ordinaryLocalCodexInventory').mockImplementation(() => {
      throw new Error('DO-NOT-ECHO-private-provider-error');
    });
    expect(() => snapshot(targetConfig, p)).toThrow(
      'Invalid ordinary local Codex capability inventory',
    );
  });
  it('returns independent copies without allowing response mutations to change resolution', () => {
    const c = snapshot();
    const original = c.inventory();
    const mutated = c.inventory();
    mutated.accounts[0].models[0].reasoningEfforts!.push('invented');
    mutated.targets[0].targetRevision = 'changed';
    mutated.routes.length = 0;
    expect(c.inventory()).toEqual(original);
    expect(c.resolve(request())).toMatchObject({
      status: 'compatible',
      binding: { execution: { targetRevision: original.targets[0].targetRevision } },
    });
  });
  it.each(
    [
      [{ ...model, id: ' whitespace ' }],
      [model, model],
      [{ ...model, reasoningEfforts: ['low', 'low'] }],
      [{ ...model, defaultReasoningEffort: 'invented' }],
      [{ ...model, reasoningEfforts: ['x'.repeat(65)] }],
      Array.from({ length: 257 }, (_, n) => ({ id: `model-${n}`, label: 'Model' })),
    ].map((models) => ({ models })),
  )('rejects ambiguous or unbounded model metadata with a finite error', ({ models }) => {
    expect(() => snapshot(targetConfig, profiles([{ ...host, models }]))).toThrow(
      'Invalid ordinary local Codex capability inventory',
    );
  });
  it('bounds the complete encoded inventory rather than only each field', () => {
    const models = Array.from({ length: 256 }, (_, n) => ({
      id: `model-${n}`,
      label: 'x'.repeat(256),
      reasoningEfforts: Array.from({ length: 16 }, (_, i) => `effort-${i}-${'x'.repeat(50)}`),
    }));
    const accounts = Array.from({ length: 64 }, (_, n) => ({ ...host, id: `host-${n}`, models }));
    expect(() => snapshot(targetConfig, profiles(accounts))).toThrow(
      'Invalid ordinary local Codex capability inventory',
    );
  });
  it('rejects excess accounts and labels without returning partial selectable inventory', () => {
    expect(() =>
      snapshot(
        targetConfig,
        profiles(Array.from({ length: 65 }, (_, n) => ({ ...host, id: `host-${n}` }))),
      ),
    ).toThrow('Invalid ordinary local Codex capability inventory');
    expect(() => snapshot(targetConfig, profiles([{ ...host, label: 'x'.repeat(257) }]))).toThrow(
      'Invalid ordinary local Codex capability inventory',
    );
  });
});
