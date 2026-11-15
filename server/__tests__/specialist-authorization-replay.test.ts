import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpecialistConsultations, type SpecialistAuthority } from '../specialist-consultations.js';

const f = vi.hoisted(() => ({
  versions: [] as Array<{
    profileId: string;
    revision: number;
    contentHash: string;
    definition: { role: string; modelPolicyRole: string };
  }>,
  accountRevision: 'account-v1',
  authCurrent: true,
  repositoryCurrent: true,
  runtimeCurrent: true,
}));
vi.mock('../auth.js', () => ({ isAuthSessionCurrent: () => f.authCurrent }));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'login' }, assertCurrent() {} }),
}));
vi.mock('../agent-library-runtime.js', () => ({
  getAgentLibrary: () => ({
    list: () => ({ versions: f.versions }),
    version: (_scope: string, id: string, revision: number) =>
      f.versions.find((p) => p.profileId === id && p.revision === revision),
  }),
}));
vi.mock('../ordinary-codex-agent-profile.js', () => ({
  resolveOrdinaryCodexAgentProfile: async ({
    requested,
    lookup,
  }: {
    requested: unknown;
    lookup(selection: unknown): unknown;
  }) => lookup(requested),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    resolve: () => ({ provider: 'openai', profileRevision: f.accountRevision }),
    validateModelSelection() {},
  }),
}));
vi.mock('../session-harness-routing.js', () => ({ sessionHarnessForProvider: () => 'codex' }));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: () => ({
    catalog: {
      resolve: () => ({
        status: f.runtimeCurrent ? 'compatible' : 'unavailable',
        binding: { execution: {} },
      }),
    },
  }),
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  repositoryWorkspaceCatalog: () => ({
    repositories: f.repositoryCurrent
      ? [{ connectionId: 'source', repository: 'example/repo' }]
      : [],
  }),
}));

const roots: string[] = [];
const services: SpecialistConsultations[] = [];
beforeEach(() => {
  f.versions = [
    {
      profileId: 'reviewer',
      revision: 1,
      contentHash: 'a'.repeat(64),
      definition: { role: 'reviewer', modelPolicyRole: 'reviewer' },
    },
  ];
  f.accountRevision = 'account-v1';
  f.authCurrent = f.repositoryCurrent = f.runtimeCurrent = true;
});
afterEach(() => {
  services.splice(0).forEach((s) => s.closeIdle());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-specialist-replay-'));
  roots.push(root);
  const owners = {
    databasePath: join(root, 'events.sqlite'),
    events: {
      getSession: () => ({ sessionType: 'ordinary' }),
      getOrdinarySessionPreparationForConversation: () => undefined,
      listSessionCollaborations: () => ({
        collaborations: [{ collaborationId: group }],
        nextCursor: null,
      }),
      getSessionCollaboration: () => ({ collaborationId: group }),
      collaborationConversation: {
        view: () => ({ participantSessionIds: ['lead'], policies: [] }),
      },
    } as never,
    workspaces: () => {
      throw Error('Authorization cannot allocate a workspace');
    },
    messaging: {} as never,
  };
  const group = randomUUID();
  const open = () => {
    const service = new SpecialistConsultations(owners);
    services.push(service);
    return service;
  };
  const controller = new AbortController();
  const authority: SpecialistAuthority = {
    leadSessionId: 'lead',
    operatorConnectionId: 'operator',
    auth: { id: 'login', expiresAt: Date.now() + 2 * 3600_000 } as SpecialistAuthority['auth'],
    signal: controller.signal,
    assertCurrent() {},
  };
  const input = {
    requestId: randomUUID(),
    repository: 'example/repo',
    connectionId: 'source',
    routes: [
      {
        role: 'reviewer',
        accountId: 'account',
        model: 'model',
        reasoningEffort: 'high',
        runOn: 'local',
        targetId: 'target',
      },
    ],
    durationMinutes: 10,
  };
  return { service: open(), open, authority, controller, input, approve: vi.fn(async () => true) };
}

it('reuses the original role pin after publication, ambiguity and a ledger reopen', async () => {
  const { service, open, authority, input, approve } = fixture();
  const policy = await service.authorize(authority, input, approve);
  f.versions.push({ ...f.versions[0], revision: 2, contentHash: 'b'.repeat(64) });
  f.versions.push({ ...f.versions[0], profileId: 'other-reviewer' });
  service.closeIdle();
  services.splice(services.indexOf(service), 1);
  const recovered = open();
  await expect(recovered.authorize(authority, input, approve)).resolves.toEqual(policy);
  expect(approve).toHaveBeenCalledOnce();
  expect(policy.routes[0].agent).toEqual({ profileId: 'reviewer', revision: 1 });
  await expect(
    recovered.authorize(authority, { ...input, requestId: randomUUID() }, approve),
  ).rejects.toThrow(/one exact published/);
});

it.each([
  { durationMinutes: 5 },
  { durationMinutes: 20 },
  { durationMinutes: undefined },
  { maxConsultations: 5 },
  { maxContextBytes: 100 },
  { repository: 'other/repo' },
  { connectionId: 'other' },
])(
  'rejects a changed authorization intent %j without approval or replacing its receipt',
  async (patch) => {
    const { service, authority, input, approve } = fixture();
    const policy = await service.authorize(authority, input, approve);
    await expect(service.authorize(authority, { ...input, ...patch }, approve)).rejects.toThrow(
      /conflict/,
    );
    expect(service.receipts.policy('lead', policy.policyId)).toEqual(policy);
    expect(approve).toHaveBeenCalledOnce();
  },
);

it('normalizes defaults and absent optional route fields through JSON persistence', async () => {
  const { service, authority, input, approve } = fixture();
  const original = {
    ...input,
    durationMinutes: undefined,
    routes: [{ ...input.routes[0], agent: undefined, modelFamily: undefined, runOn: undefined }],
  };
  const policy = await service.authorize(authority, original, approve);
  await expect(
    service.authorize(
      authority,
      {
        ...JSON.parse(JSON.stringify(original)),
        durationMinutes: 30,
        maxConsultations: 4,
        maxContextBytes: 32000,
      },
      approve,
    ),
  ).resolves.toEqual(policy);
  expect(approve).toHaveBeenCalledOnce();
});

it('preserves an explicit original revision and reviews a new request for a newer revision', async () => {
  const { service, authority, input, approve } = fixture();
  const selected = {
    ...input,
    routes: [{ ...input.routes[0], agent: { profileId: 'reviewer', revision: 1 } }],
  };
  const original = await service.authorize(authority, selected, approve);
  f.versions.push({ ...f.versions[0], revision: 2, contentHash: 'b'.repeat(64) });
  await expect(service.authorize(authority, selected, approve)).resolves.toEqual(original);
  expect(approve).toHaveBeenCalledOnce();
  const next = await service.authorize(
    authority,
    {
      ...selected,
      requestId: randomUUID(),
      routes: [{ ...selected.routes[0], agent: { profileId: 'reviewer', revision: 2 } }],
    },
    approve,
  );
  expect(next.routes[0].agent.revision).toBe(2);
  expect(approve).toHaveBeenCalledTimes(2);
});

it('rejects changed route choices while keeping the approved role pin', async () => {
  const { service, authority, input, approve } = fixture();
  const policy = await service.authorize(authority, input, approve);
  for (const patch of [
    { agent: { profileId: 'reviewer', revision: 1 } },
    { model: 'other-model' },
    { accountId: 'other-account' },
    { targetId: 'other-target' },
    { reasoningEffort: 'low' },
  ])
    await expect(
      service.authorize(
        authority,
        {
          ...input,
          routes: [{ ...input.routes[0], ...patch }],
        },
        approve,
      ),
    ).rejects.toThrow(/conflict/);
  expect(service.receipts.policy('lead', policy.policyId)).toEqual(policy);
  expect(approve).toHaveBeenCalledOnce();
});

it.each([
  'revoked',
  'expired',
  'login',
  'auth',
  'cancelled',
  'account',
  'runtime',
  'repository',
  'profile',
])('rechecks %s authority on an unchanged replay', async (guard) => {
  const { service, authority, input, approve, controller } = fixture();
  const policy = await service.authorize(authority, input, approve);
  if (guard === 'revoked') service.receipts.revoke('lead', policy.policyId);
  if (guard === 'expired') vi.spyOn(Date, 'now').mockReturnValue(policy.expiresAt + 1);
  if (guard === 'login') authority.auth = { ...authority.auth, id: 'replacement-login' };
  if (guard === 'auth') f.authCurrent = false;
  if (guard === 'cancelled') controller.abort();
  if (guard === 'account') f.accountRevision = 'account-v2';
  if (guard === 'runtime') f.runtimeCurrent = false;
  if (guard === 'repository') f.repositoryCurrent = false;
  if (guard === 'profile') f.versions = [];
  await expect(service.authorize(authority, input, approve)).rejects.toThrow();
  expect(approve).toHaveBeenCalledOnce();
});

it('refuses to invent original intent for legacy receipts, preserving their existing policy', async () => {
  const { service, authority, input, approve } = fixture();
  const policy = await service.authorize(authority, input, approve);
  const legacyInput = {
    requestId: randomUUID(),
    expiresAt: policy.expiresAt,
    repository: policy.repository,
    connectionId: policy.connectionId,
    routes: policy.routes,
    maxConsultations: policy.maxConsultations,
    maxContextBytes: policy.maxContextBytes,
  };
  const legacy = service.receipts.authorize('lead', 'login', legacyInput);
  await expect(
    service.authorize(authority, { ...input, requestId: legacy.policyId }, approve),
  ).rejects.toThrow(/Original policy request is unavailable/);
  expect(service.receipts.assertPolicy('lead', 'login', legacy.policyId)).toEqual(legacy);
  expect(approve).toHaveBeenCalledOnce();
});
