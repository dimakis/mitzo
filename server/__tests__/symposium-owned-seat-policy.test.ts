import { installedVertexStatus } from './fixtures/vertex-policy-status.js';
import upstreamInput from './fixtures/vertex-policy-854b/input.json';
import upstreamCanonical from './fixtures/vertex-policy-854b/canonical.json';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AccountProfiles } from '../account-profiles.js';
import { createOwnedSeatPolicySelector } from '../symposium-owned-seat-policy.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture(upstream = false) {
  const projectId = upstream ? 'itpc-ca-638a2a9c7c' : 'selected-project';
  const provider = upstream ? 'symposium-vertex-offline-probe' : 'vertex-work';
  const root = mkdtempSync(join(tmpdir(), 'owned-seat-policy-'));
  roots.push(root);
  const basePolicy = join(root, 'base.json');
  const base = upstream
    ? upstreamInput
    : {
        version: 1,
        filesystem_policy: { include_workdir: true, read_only: ['/usr'], read_write: ['/sandbox'] },
        landlock: { compatibility: 'best_effort' },
        network_policies: { codex: { endpoints: [{ host: 'chatgpt.com' }] } },
      };
  const bytes = JSON.stringify(base);
  writeFileSync(basePolicy, bytes, { mode: 0o600 });
  const profiles = new AccountProfiles([
    {
      id: 'work',
      label: 'Work',
      provider: 'anthropic-vertex',
      credentialRef: '/never-read-adc',
      projectId,
      region: 'global',
      sandboxProvider: provider,
      sandboxProviderId: 'vertex-id',
      models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
    },
  ]);
  const binding = profiles.resolve('work', 'claude-haiku-4-5@20251001');
  const seat = { id: 'seat', accountBinding: binding, model: binding.model };
  const membership = { state: 'active', generation: 1 };
  const facts = {
    getActiveSymposiumConfig: () => ({ version: 2, state: 'active', seats: [seat] }),
    getLatestSymposiumMembership: () => membership,
  };
  const gateway = {
    stateDirectory: root,
    workspace: 'workspace',
    gateway: 'owned',
    verifyCustody: vi.fn(),
  };
  const receipt = {
    principal: 'work@example.test',
    accountId: 'work',
    provider,
    providerId: 'vertex-id',
    projectId,
    region: 'global',
    model: binding.model,
    workspace: 'workspace',
  };
  const capture = vi.fn(() => receipt),
    hostGrants = { verifySeat: vi.fn() };
  const invoke = vi.fn<(args: readonly string[]) => string>(() => {
    throw Error('No inspection fixture');
  });
  const resolve = createOwnedSeatPolicySelector({
    invoke,
    gateway: gateway as never,
    basePolicy,
    baseDigest: createHash('sha256').update(bytes).digest('hex'),
    facts: facts as never,
    currentProfiles: () => profiles,
    hostGrants,
    capture: capture as never,
  });
  const request = { sessionId: 'session', seatId: 'seat', generation: 1 };
  return {
    root,
    basePolicy,
    base,
    seat,
    membership,
    receipt,
    capture,
    hostGrants,
    resolve,
    request,
    invoke,
  };
}
it('derives an immutable exact Vertex-only policy from the retained selected account', () => {
  const f = fixture(),
    p = f.resolve(f.request)!;
  const policy = JSON.parse(readFileSync(p.path, 'utf8'));
  expect(Object.keys(policy.network_policies)).toEqual(['claude_vertex_haiku']);
  const rule = policy.network_policies.claude_vertex_haiku;
  expect(rule.binaries).toEqual([{ path: '/usr/local/bin/claude' }]);
  expect(rule.endpoints.map((e: { path: string }) => e.path)).toEqual(
    ['rawPredict', 'streamRawPredict'].map(
      (op) =>
        `/v1/projects/selected-project/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:${op}`,
    ),
  );
  for (const endpoint of rule.endpoints)
    expect(endpoint).toMatchObject({
      host: 'aiplatform.googleapis.com',
      credential_binding: { provider: 'vertex-work' },
      protocol: 'rest',
      enforcement: 'enforce',
      request_body_credential_rewrite: false,
      allow_uninspected_credentials: false,
    });
  expect(policy.filesystem_policy).toEqual(f.base.filesystem_policy);
  expect(policy.landlock).toEqual(f.base.landlock);
  expect(readFileSync(p.path, 'utf8')).not.toContain('chatgpt.com');
  expect(p.sha256).toBe(createHash('sha256').update(readFileSync(p.path)).digest('hex'));
  p.verify();
  expect(f.capture.mock.calls.length).toBeGreaterThan(1);
  expect(f.resolve(f.request)?.path).toBe(p.path);
});
it.each([
  'accountId',
  'provider',
  'providerId',
  'projectId',
  'region',
  'model',
  'workspace',
] as const)('rejects retained %s drift before creating policy', (field) => {
  const f = fixture();
  f.receipt[field] = 'foreign';
  expect(() => f.resolve(f.request)).toThrow();
});
it('rejects policy-byte, grant and generation drift at verification boundaries', () => {
  const f = fixture(),
    p = f.resolve(f.request)!;
  chmodSync(p.path, 0o600);
  writeFileSync(p.path, '{}');
  chmodSync(p.path, 0o400);
  expect(() => p.verify()).toThrow();
  const g = fixture(),
    q = g.resolve(g.request)!;
  g.hostGrants.verifySeat.mockImplementation(() => {
    throw Error('revoked');
  });
  expect(() => q.verify()).toThrow();
  const h = fixture(),
    r = h.resolve(h.request)!;
  h.membership.generation++;
  expect(() => r.verify()).toThrow();
});
it('never silently adopts changed base policy or another account route', () => {
  const f = fixture();
  writeFileSync(f.basePolicy, '{}');
  expect(() => f.resolve(f.request)).toThrow();
  const g = fixture();
  g.seat.accountBinding = { ...g.seat.accountBinding, accountId: 'other' };
  expect(() => g.resolve(g.request)).toThrow();
});

it('binds effective full policy to exact installed sandbox and rejects added rules or stale revision', () => {
  const f = fixture();
  const p = f.resolve(f.request)!;
  const expected = JSON.parse(readFileSync(p.path, 'utf8'));
  // The pinned protobuf serializer omits false endpoint options.
  for (const e of expected.network_policies.claude_vertex_haiku.endpoints) {
    delete e.request_body_credential_rewrite;
    delete e.allow_uninspected_credentials;
  }
  const sandbox = {
    name: 'seat-box',
    id: 'box-id',
    workspace: 'workspace',
    phase: 'Ready',
    labels: { 'mitzo.account_provider': 'vertex-work' },
  };
  const effective = {
    scope: 'sandbox',
    sandbox: 'seat-box',
    status: 'effective',
    policy_source: 'sandbox',
    version: 1,
    active_version: 1,
    config_revision: 9223372036854776000,
    hash: 'a'.repeat(64),
    policy: expected,
  };
  const invoke = f.invoke.mockImplementation((args: readonly string[]) =>
    JSON.stringify(
      args[0] === 'policy'
        ? effective
        : args.includes('status')
          ? installedVertexStatus({
              name: sandbox.name,
              id: sandbox.id,
              workspace: 'workspace',
              provider: f.receipt.provider,
              providerId: f.receipt.providerId,
              hash: effective.hash,
              revision: String(effective.config_revision),
            })
          : sandbox,
    ),
  );
  p.verifyInstalled({ sandboxName: 'seat-box', sandboxId: 'box-id' });
  expect(invoke.mock.calls[1][0]).toEqual([
    'policy',
    '--gateway',
    'owned',
    '--workspace',
    'workspace',
    'get',
    'seat-box',
    '--full',
    '--output',
    'json',
  ]);
  effective.policy.network_policies.other = { endpoints: [{ host: 'chatgpt.com' }] };
  expect(() => p.verifyInstalled({ sandboxName: 'seat-box', sandboxId: 'box-id' })).toThrow();
  delete effective.policy.network_policies.other;
  effective.active_version = 2;
  expect(() => p.verifyInstalled({ sandboxName: 'seat-box', sandboxId: 'box-id' })).toThrow();
  effective.active_version = 1;
  sandbox.id = 'replacement';
  expect(() => p.verifyInstalled({ sandboxName: 'seat-box', sandboxId: 'box-id' })).toThrow();
});

it('accepts the actual pinned Rust parser canonical output without broad normalization', () => {
  const f = fixture(true),
    p = f.resolve(f.request)!;
  const sandbox = {
    name: 'seat-box',
    id: 'box-id',
    workspace: 'workspace',
    phase: 'Ready',
    labels: { 'mitzo.account_provider': f.receipt.provider },
  };
  const observed = {
    scope: 'sandbox',
    sandbox: 'seat-box',
    status: 'effective',
    policy_source: 'sandbox',
    version: 1,
    active_version: 1,
    config_revision: 9223372036854776000,
    hash: 'a'.repeat(64),
    policy: structuredClone(upstreamCanonical),
  };
  f.invoke.mockImplementation((args) =>
    JSON.stringify(
      args[0] === 'policy'
        ? observed
        : args.includes('status')
          ? installedVertexStatus({
              name: sandbox.name,
              id: sandbox.id,
              workspace: 'workspace',
              provider: f.receipt.provider,
              providerId: f.receipt.providerId,
              hash: observed.hash,
              revision: String(observed.config_revision),
            })
          : sandbox,
    ),
  );
  p.verifyInstalled({ sandboxName: 'seat-box', sandboxId: 'box-id' });
  const endpoint = observed.policy.network_policies.claude_vertex_haiku.endpoints[0];
  for (const change of [
    { host: 'chatgpt.com' },
    { request_body_credential_rewrite: true },
    { credential_binding: { provider: 'other-seat' } },
    { rules: [{ allow: { method: 'GET', path: '/**' } }] },
  ]) {
    observed.policy = structuredClone(upstreamCanonical);
    Object.assign(observed.policy.network_policies.claude_vertex_haiku.endpoints[0], change);
    expect(() => p.verifyInstalled({ sandboxName: 'seat-box', sandboxId: 'box-id' })).toThrow();
  }
  expect(endpoint.host).toBe('aiplatform.googleapis.com');
});

it.each([
  'pending',
  'credentials',
  'policy',
  'environment',
  'hash',
  'revision',
  'epoch',
  'sandbox',
  'provider',
])('rejects supervisor %s mismatch despite matching desired policy', (failure) => {
  const f = fixture(),
    p = f.resolve(f.request)!;
  const effective = {
    scope: 'sandbox',
    sandbox: 'seat-box',
    status: 'effective',
    policy_source: 'sandbox',
    version: 1,
    active_version: 1,
    config_revision: 9223372036854776000,
    hash: 'a'.repeat(64),
    policy: JSON.parse(readFileSync(p.path, 'utf8')),
  };
  const sandbox = {
    name: 'seat-box',
    id: 'box-id',
    workspace: 'workspace',
    phase: 'Ready',
    labels: { 'mitzo.account_provider': f.receipt.provider },
  };
  const installed = installedVertexStatus({
    name: sandbox.name,
    id: sandbox.id,
    workspace: 'workspace',
    provider: f.receipt.provider,
    providerId: f.receipt.providerId,
    hash: effective.hash,
    revision: String(effective.config_revision),
  });
  const target = installed.targets[0];
  if (failure === 'pending') target.state = 'pending';
  if (failure === 'credentials') target.observed.credentials_installed = false;
  if (failure === 'policy') target.observed.policy_active = false;
  if (failure === 'environment') target.observed.launch_environment_installed = false;
  if (failure === 'hash') target.observed.policy_hash = 'b'.repeat(64);
  if (failure === 'revision') target.observed.config_revision = '9223372036854776001';
  if (failure === 'epoch') target.observed.attachment_epoch = 'other';
  if (failure === 'sandbox') target.receipt.desired.sandbox_id = 'other';
  if (failure === 'provider') target.receipt.desired.provider_id = 'other';
  f.invoke.mockImplementation((args) =>
    JSON.stringify(
      args[0] === 'policy' ? effective : args.includes('status') ? installed : sandbox,
    ),
  );
  expect(() => p.verifyInstalled({ sandboxName: sandbox.name, sandboxId: sandbox.id })).toThrow();
});

it('matches exact u64 maximum across raw effective config and string supervisor receipts', () => {
  const f = fixture(),
    p = f.resolve(f.request)!;
  const sandbox = {
    name: 'seat-box',
    id: 'box-id',
    workspace: 'workspace',
    phase: 'Ready',
    labels: { 'mitzo.account_provider': f.receipt.provider },
  };
  const effective = {
    scope: 'sandbox',
    sandbox: 'seat-box',
    status: 'effective',
    policy_source: 'sandbox',
    version: 1,
    active_version: 1,
    config_revision: 'U64',
    hash: 'a'.repeat(64),
    policy: JSON.parse(readFileSync(p.path, 'utf8')),
  };
  const installed = installedVertexStatus({
    name: sandbox.name,
    id: sandbox.id,
    workspace: 'workspace',
    provider: f.receipt.provider,
    providerId: f.receipt.providerId,
    hash: effective.hash,
    revision: '18446744073709551615',
  });
  f.invoke.mockImplementation((args) =>
    args[0] === 'policy'
      ? JSON.stringify(effective).replace('"U64"', '18446744073709551615')
      : JSON.stringify(args.includes('status') ? installed : sandbox),
  );
  p.verifyInstalled({ sandboxName: sandbox.name, sandboxId: sandbox.id }, true);
  expect(f.invoke.mock.calls.find(([args]) => args.includes('status'))![0]).toContain('--wait');
  installed.targets[0].observed.config_revision = '18446744073709551614';
  expect(() => p.verifyInstalled({ sandboxName: sandbox.name, sandboxId: sandbox.id })).toThrow();
});

it('retains its own exclusively created bytes after transient first post-write verification failure', () => {
  const f = fixture();
  let calls = 0;
  f.capture.mockImplementation(() => {
    if (++calls === 2) throw Error('readiness temporarily unavailable');
    return f.receipt;
  });
  expect(() => f.resolve(f.request)).toThrow('readiness temporarily unavailable');
  const recovered = f.resolve(f.request)!;
  recovered.verify();
  expect(f.resolve(f.request)?.path).toBe(recovered.path);
});

it.each(['root', 'filesystem', 'rule', 'binding', 'allow'])(
  'rejects false credential options added outside endpoints at %s',
  (location) => {
    const f = fixture(true),
      p = f.resolve(f.request)!;
    const policy = structuredClone(upstreamCanonical);
    const rule = policy.network_policies.claude_vertex_haiku;
    const target =
      location === 'root'
        ? policy
        : location === 'filesystem'
          ? policy.filesystem_policy
          : location === 'rule'
            ? rule
            : location === 'binding'
              ? rule.endpoints[0].credential_binding
              : rule.endpoints[0].rules[0].allow;
    Object.assign(target, { request_body_credential_rewrite: false });
    const sandbox = {
      name: 'seat-box',
      id: 'box-id',
      workspace: 'workspace',
      phase: 'Ready',
      labels: { 'mitzo.account_provider': f.receipt.provider },
    };
    const effective = {
      scope: 'sandbox',
      sandbox: 'seat-box',
      status: 'effective',
      policy_source: 'sandbox',
      version: 1,
      active_version: 1,
      config_revision: 1,
      hash: 'a'.repeat(64),
      policy,
    };
    const status = installedVertexStatus({
      name: sandbox.name,
      id: sandbox.id,
      workspace: 'workspace',
      provider: f.receipt.provider,
      providerId: f.receipt.providerId,
      hash: effective.hash,
      revision: '1',
    });
    f.invoke.mockImplementation((args) =>
      JSON.stringify(args[0] === 'policy' ? effective : args.includes('status') ? status : sandbox),
    );
    expect(() => p.verifyInstalled({ sandboxName: sandbox.name, sandboxId: sandbox.id })).toThrow();
  },
);
