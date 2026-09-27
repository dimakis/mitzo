import { stableSymposiumArtifactLeasePath } from '../symposium-artifact-state.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountBindingSchema, type SeatConfig, type SymposiumConfig } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
const profiles = new AccountProfiles([
  {
    id: 'work-api',
    label: 'Work OpenAI',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    sandboxProviderId: 'openai-object',
    models: [{ id: 'gpt-test', label: 'Test' }],
  },
  {
    id: 'work-vertex',
    label: 'Work Claude',
    provider: 'anthropic-vertex',
    projectId: 'work-project',
    region: 'us-east5',
    credentialRef: '/host/adc.json',
    sandboxProvider: 'vertex-work',
    sandboxProviderId: 'vertex-object',
    models: [{ id: 'claude-test', label: 'Test' }],
  },
]);
const seat = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  model: 'gpt-test',
  systemPrompt: 'Review only.',
  color: '#223344',
  accountBinding: AccountBindingSchema.parse(profiles.resolve('work-api', 'gpt-test')),
  profileBinding: { profileId: 'reviewer', profileRevision: 'p1' },
  contextGrant: {
    grantId: 'context',
    revision: 1,
    classification: 'work' as const,
    sourceRefs: [],
  },
  authorityGrant: {
    grantId: 'authority',
    revision: 1,
    filesystem: 'read' as const,
    tools: 'read' as const,
    network: 'restricted' as const,
  },
  isolationRequest: {
    trustDomainId: 'shared',
    revision: 1,
    placement: 'reuse-compatible' as const,
  },
} satisfies SeatConfig;
const config: SymposiumConfig = {
  version: 2,
  revision: 4,
  state: 'active',
  anchorSeatId: 'reviewer',
  activeSeatCap: 3,
  seats: [seat],
  turnRules: { mode: 'directed', maxTurns: 10 },
  interceptMode: 'manual',
};

import { createHash } from 'node:crypto';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import type { ArtifactLeaseRequest } from '../symposium-artifact-lease.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-pending-retention-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new EventStore(join(root, 'events.db'));
  cleanups.push(() => store.close());
  store.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
  store.setSymposiumConfig('symposium', config);
  const path = stableSymposiumArtifactLeasePath(root);
  let launch = 0;
  const evidence = {
    verifyGateway: vi.fn(async () => {}),
    verifyMount: vi.fn(async () => {}),
    verifyDeleted: vi.fn(async () => {}),
  };
  const open = () => {
    mkdirSync(join(root, `gateway-${++launch}`), { mode: 0o700 });
    expect(stableSymposiumArtifactLeasePath(root)).toBe(path);
    const host = new SqliteArtifactLeaseHost(path, evidence, async () => []);
    chmodSync(path, 0o600);
    chmodSync(`${path}-wal`, 0o600);
    chmodSync(`${path}-shm`, 0o600);
    cleanups.push(() => host.close());
    return host;
  };
  const a = open();
  const b = open();
  const request: ArtifactLeaseRequest = {
    sessionId: 'symposium',
    workspaceId: 'workspace',
    seatId: 'reviewer',
    volumeName: 'volume',
    volumeGeneration: 'generation',
    driver: 'podman',
    access: 'writer',
  };
  const lease = await a.reserve(request);
  const selection = {
    sessionId: 'symposium',
    expectedConfigRevision: 4,
    idempotencyKey: 'seal',
    custody: { workspaceId: 'workspace', gatewayLaunchDigest: 'a'.repeat(64) },
    artifact: {
      driver: 'podman' as const,
      volumeName: 'volume',
      volumeGeneration: 'generation',
      leaseRevision: lease.revision,
      leaseTokenHash: createHash('sha256').update(lease.token).digest('hex'),
    },
  };
  const bind = () => {
    a.markCreationStarted(lease.token, lease.revision, 'writer-sandbox');
    a.bindSandbox(lease.token, lease.revision, 'writer-sandbox', 'physical-writer');
  };
  return { store, a, b, open, request, lease, selection, bind, evidence };
}
it('requires the persisted session fence and exact bound writer, never missing or stale custody', async () => {
  const f = await fixture();
  expect(() => f.a.beginPendingArtifactRetention(f.store, 'symposium')).toThrow(/durable session/);
  f.store.beginSymposiumArtifactSeal(f.selection);
  expect(() => f.a.beginPendingArtifactRetention(f.store, 'symposium')).toThrow(
    /exact bound writer/,
  );
  f.bind();
  const retention = f.a.beginPendingArtifactRetention(f.store, 'symposium');
  expect(retention).toMatchObject({
    kind: 'pending_artifact_retention',
    status: 'pending_unsealed',
    writerSandboxId: 'physical-writer',
  });
  expect(retention).not.toHaveProperty('revocation');
  expect(retention).not.toHaveProperty('gitRevision');
  expect(f.evidence.verifyDeleted).not.toHaveBeenCalled();
});
it('survives cleanup/reopen and fences all new leases across sessions, access and volume generations', async () => {
  const f = await fixture();
  f.bind();
  f.store.beginSymposiumArtifactSeal(f.selection);
  const retained = f.a.beginPendingArtifactRetention(f.store, 'symposium');
  await f.a.releaseBoundSandbox(f.request, 'writer-sandbox', 'physical-writer', async () => {});
  expect(await f.b.inspectLease(f.lease.token)).toBeNull();
  const reopened = f.open();
  expect(reopened.beginPendingArtifactRetention(f.store, 'symposium')).toEqual(retained);
  for (const change of [
    {},
    { access: 'reviewer' as const },
    { sessionId: 'other' },
    { volumeGeneration: 'generation-2' },
  ])
    await expect(reopened.reserve({ ...f.request, ...change })).rejects.toThrow(
      /pending retention/,
    );
  expect((await f.b.reserve({ ...f.request, volumeName: 'other-volume' })).token).toBeTruthy();
  expect(f.store.getSymposiumArtifactSealIntent('symposium')?.status).toBe('pending_unsealed');
});
it.each(['volumeGeneration', 'leaseRevision', 'leaseTokenHash'] as const)(
  'rejects stale %s while retaining the earlier session fence',
  async (field) => {
    const f = await fixture();
    f.bind();
    const selection = structuredClone(f.selection);
    selection.artifact[field] = field === 'leaseTokenHash' ? 'c'.repeat(64) : 'changed';
    f.store.beginSymposiumArtifactSeal(selection);
    expect(() => f.a.beginPendingArtifactRetention(f.store, 'symposium')).toThrow(
      /exact bound writer/,
    );
    expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
  },
);
it('fails closed if writer release wins before retention, rather than adopting its receipt', async () => {
  const f = await fixture();
  f.bind();
  f.store.beginSymposiumArtifactSeal(f.selection);
  await f.b.releaseBoundSandbox(f.request, 'writer-sandbox', 'physical-writer', async () => {});
  expect(() => f.a.beginPendingArtifactRetention(f.store, 'symposium')).toThrow(
    /exact bound writer/,
  );
  expect(() => f.store.assertSymposiumArtifactWorkAllowed('symposium')).toThrow(/fenced/);
});
