import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const testHome = vi.hoisted(() => `/private/tmp/mitzo-disposition-tests-${process.pid}`);
vi.mock('node:os', () => ({ homedir: () => testHome }));
import {
  createContainedNativeDispositionPlan,
  createContainedNativeDispositionOwner,
  CONTAINED_NATIVE_INCIDENT,
} from '../staging-contained-native-disposition.js';
import { openStagingRegistry, type StagingRecord } from '../symposium-staging-registry.js';

const root = join(testHome, '.local/share/mitzo-staging');
const operation = '11111111-1111-4111-8111-111111111111';
const allocation = '22222222-2222-4222-8222-222222222222';
const hash = 'a'.repeat(64);
function fixture() {
  const directory = join(root, 'registry');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registry = openStagingRegistry(directory, 1);
  const row: StagingRecord = {
    ...CONTAINED_NATIVE_INCIDENT,
    ownerChat: 'original owner',
    purpose: 'canonical stage',
    retentionReason: 'uncertain cleanup',
    planDirectory: join(root, 'symposium/service'),
    reviewAfter: Date.now() + 86400_000,
    state: 'retirement_uncertain',
    retirementStateParent: null,
    completedAt: null,
  };
  const db = new Database(join(directory, 'staging.db'));
  const fields = Object.keys(row);
  db.prepare(
    `INSERT INTO launches (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
  ).run(...Object.values(row));
  db.close();
  const registration = {
    ownerChat: 'fresh operator',
    purpose: 'canonical native replica',
    retentionReason: 'bounded acceptance',
    reviewAfter: Date.now() + 86400_000,
    planDirectory: join(root, 'symposium/service/allocations', allocation),
    sourceCommit: 'b'.repeat(40),
    buildSha256: hash,
    configSha256: hash,
  };
  const facts = {
    version: 1 as const,
    canonicalRoot: root,
    capacity: 1 as const,
    operation,
    allocation,
    original: row,
    archiveRoot: root + '-quarantine/' + operation,
    containmentReceiptSha256: hash,
    recoveryCompletionSha256: hash,
    registryBackupSha256: hash,
    archiveManifestSha256: hash,
    physicalEvidenceSha256: hash,
    acceptedController: 'c'.repeat(40),
    controllerInventorySha256: hash,
    runtimeConfigurationSha256: hash,
    registration,
  };
  return { registry, facts, row, registration };
}
afterEach(() => rmSync(testHome, { recursive: true, force: true }));
function effects(_f: ReturnType<typeof fixture>) {
  const events: string[] = [];
  let guardCurrent = true,
    authCurrent = true;
  const assertion = () => {
    if (!guardCurrent || !authCurrent) throw Error('lease expired');
  };
  const e = {
    assertAcceptedSource: vi.fn(async () => {
      events.push('source');
    }),
    acquireGuard: vi.fn(async () => ({
      assertCurrent: () => {
        if (!guardCurrent) throw Error('guard lost');
      },
      close: () => {
        guardCurrent = false;
      },
    })),
    assertNoPriorDisposition: vi.fn(async () => {
      events.push('prior');
    }),
    verifyCompletedContainment: vi.fn(async () => {
      events.push('physical');
    }),
    authenticateNativeAllocation: vi.fn(async (_sha: string, purpose: string) => {
      events.push('auth');
      expect(purpose).toBe('one_canonical_native_allocation_cleanup_unconfirmed');
      return {};
    }),
    consumeOperatorAuthority: vi.fn(() => ({
      assertCurrent: assertion,
      close: () => {
        authCurrent = false;
      },
    })),
    appendDisposition: vi.fn(async () => {
      events.push('ledger');
    }),
  };
  return {
    e,
    events,
    expire: () => {
      authCurrent = false;
    },
    loseGuard: () => {
      guardCurrent = false;
    },
  };
}
describe('incident-specific native capacity disposition', () => {
  it('produces a proposal without claiming cleanup, retirement or executable authority', () => {
    const f = fixture();
    const plan = createContainedNativeDispositionPlan(f.facts);
    expect(plan).toMatchObject({
      executable: false,
      capacity: 1,
      nativeCleanupConfirmed: false,
      originalRegistryState: 'retirement_uncertain',
    });
    f.registry.close();
  });
  it.each([
    'launchId',
    'instanceId',
    'sourceCommit',
    'buildSha256',
    'configSha256',
    'controllerGeneration',
    'createdAt',
  ])('refuses changed original %s', (field) => {
    const f = fixture();
    expect(() =>
      createContainedNativeDispositionPlan({
        ...f.facts,
        original: { ...f.row, [field]: 'changed' },
      }),
    ).toThrow();
    f.registry.close();
  });
  it('refuses capacity changes, reused plan paths and archive aliases', () => {
    const f = fixture();
    expect(() => createContainedNativeDispositionPlan({ ...f.facts, capacity: 2 })).toThrow();
    expect(() =>
      createContainedNativeDispositionPlan({
        ...f.facts,
        registration: { ...f.registration, planDirectory: f.row.planDirectory },
      }),
    ).toThrow();
    expect(() =>
      createContainedNativeDispositionPlan({ ...f.facts, archiveRoot: root + '/archive' }),
    ).toThrow();
    f.registry.close();
  });
  it('holds the original guard and rechecks physical evidence after purpose-specific authentication before granting one reservation', async () => {
    const f = fixture(),
      { e, events } = effects(f);
    const owner = createContainedNativeDispositionOwner(e);
    const grant = await owner.authorize(createContainedNativeDispositionPlan(f.facts));
    expect(events).toEqual([
      'source',
      'source',
      'prior',
      'physical',
      'auth',
      'source',
      'physical',
      'prior',
      'ledger',
      'physical',
    ]);
    expect(() => f.registry.reserve(f.registration)).toThrow('capacity');
    const original = JSON.stringify(f.registry.list()[0]);
    const reservation = f.registry.reserveWithContainedDisposition(f.registration, grant.lease);
    expect(JSON.stringify(f.registry.list()[0])).toBe(original);
    expect(f.registry.list()).toHaveLength(2);
    expect(() => f.registry.reserveWithContainedDisposition(f.registration, grant.lease)).toThrow();
    expect(reservation.launchId).not.toBe(f.row.launchId);
    grant.close();
    f.registry.close();
  });
  it('refuses JSON receipt/lease forgery and changed target registration', async () => {
    const f = fixture(),
      { e } = effects(f);
    const grant = await createContainedNativeDispositionOwner(e).authorize(
      createContainedNativeDispositionPlan(f.facts),
    );
    expect(() =>
      f.registry.reserveWithContainedDisposition(
        f.registration,
        JSON.parse(JSON.stringify(grant.lease)),
      ),
    ).toThrow();
    expect(() =>
      f.registry.reserveWithContainedDisposition(
        { ...f.registration, sourceCommit: 'd'.repeat(40) },
        grant.lease,
      ),
    ).toThrow();
    expect(() => f.registry.reserveWithContainedDisposition(f.registration, grant.lease)).toThrow();
    grant.close();
    f.registry.close();
  });
  it.each([
    'assertAcceptedSource',
    'verifyCompletedContainment',
    'authenticateNativeAllocation',
    'appendDisposition',
  ])('refuses failed %s before reservation', async (name) => {
    const f = fixture(),
      { e } = effects(f);
    e[name as keyof typeof e] = vi.fn(async () => {
      throw Error('refusal');
    }) as never;
    await expect(
      createContainedNativeDispositionOwner(e).authorize(
        createContainedNativeDispositionPlan(f.facts),
      ),
    ).rejects.toThrow();
    expect(f.registry.list()).toEqual([f.row]);
    f.registry.close();
  });
  it('refuses a replaced guard, expired authentication and drift of the original row', async () => {
    const f = fixture(),
      { e, loseGuard } = effects(f);
    const grant = await createContainedNativeDispositionOwner(e).authorize(
      createContainedNativeDispositionPlan(f.facts),
    );
    loseGuard();
    expect(() => f.registry.reserveWithContainedDisposition(f.registration, grant.lease)).toThrow();
    grant.close();
    f.registry.close();
  });
  it('burns an attempted lease even when target validation fails before transaction entry', async () => {
    const f = fixture(),
      { e } = effects(f);
    const grant = await createContainedNativeDispositionOwner(e).authorize(
      createContainedNativeDispositionPlan(f.facts),
    );
    expect(() =>
      f.registry.reserveWithContainedDisposition(
        { ...f.registration, sourceCommit: 'invalid' },
        grant.lease,
      ),
    ).toThrow();
    expect(() => f.registry.reserveWithContainedDisposition(f.registration, grant.lease)).toThrow();
    expect(f.registry.list()).toEqual([f.row]);
    grant.close();
    f.registry.close();
  });
  it('refuses expired original authentication at admission', async () => {
    const f = fixture(),
      { e, expire } = effects(f);
    const grant = await createContainedNativeDispositionOwner(e).authorize(
      createContainedNativeDispositionPlan(f.facts),
    );
    expire();
    expect(() => f.registry.reserveWithContainedDisposition(f.registration, grant.lease)).toThrow();
    expect(f.registry.list()).toEqual([f.row]);
    grant.close();
    f.registry.close();
  });
  it('rechecks every original registry column inside the reservation transaction', async () => {
    const f = fixture(),
      { e } = effects(f);
    const grant = await createContainedNativeDispositionOwner(e).authorize(
      createContainedNativeDispositionPlan(f.facts),
    );
    const db = new Database(join(root, 'registry/staging.db'));
    db.prepare('UPDATE launches SET retentionReason=? WHERE launchId=?').run(
      'changed after authentication',
      f.row.launchId,
    );
    db.close();
    expect(() => f.registry.reserveWithContainedDisposition(f.registration, grant.lease)).toThrow();
    expect(f.registry.list()).toHaveLength(1);
    grant.close();
    f.registry.close();
  });
  it('cannot mint a second lease from one original owner or replay a disposition with reopened registry metadata', async () => {
    const f = fixture(),
      { e } = effects(f);
    const owner = createContainedNativeDispositionOwner(e),
      plan = createContainedNativeDispositionPlan(f.facts);
    const grant = await owner.authorize(plan);
    await expect(owner.authorize(plan)).rejects.toThrow();
    grant.close();
    expect(() =>
      f.registry.reserveWithContainedDisposition(f.registration, { planSha256: plan.sha256 }),
    ).toThrow();
    f.registry.close();
  });
});
