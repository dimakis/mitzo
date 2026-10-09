import { it, expect } from 'vitest';
import { verifyKeyRecovery } from '../../scripts/lib/staging-key-recovery.mjs';
import { mkdtempSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('rejects an unqualified or aliased recovery receipt before any mutation', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'key-recovery-'));
  chmodSync(root, 0o700);
  try {
    await expect(
      verifyKeyRecovery(root, { version: 2, archive: '/wrong', operation: '../escape' }),
    ).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { hash } from '../../scripts/lib/staging-cold-audit.mjs';
import { installFreshKeyConfiguration } from '../../scripts/lib/staging-key-configuration.mjs';
function boundFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'key-recovery-'));
  chmodSync(root, 0o700);
  const operation = '800c57ad-c490-4330-8589-9430462ac8dd',
    launchId = '1802450e-a87e-45f1-82ce-3c4acdf91a92',
    oldId = 'd96ded23-e04b-45cf-91e9-92c5c7e61b62';
  const oldArchive = join(root, 'service/cold-refusals', operation),
    archive = join(oldArchive, 'key-refusals', launchId);
  for (const p of ['service', 'registry', 'symposium/settings'])
    mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  for (const a of [oldArchive, archive])
    for (const p of ['service', 'workspace', 'gateway-state', 'registry'])
      mkdirSync(join(a, p), { recursive: true, mode: 0o700 });
  const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }),
    config = {
      gateway: {
        jwt: { signingKey: '/old/signing', publicKey: '/old/public', kid: '/old/kid' },
        port: 18990,
      },
      personal: { workProfiles: [] },
    };
  write(join(root, 'symposium/settings/owned-host.json'), config);
  const raw = readFileSync(join(root, 'symposium/settings/owned-host.json')),
    configHash = hash(raw),
    lock = { id: operation, mode: 'ordinary-to-owned', target: 'a'.repeat(40) };
  write(join(root, 'service/deployment.lock'), lock);
  const plan = {
    sourceCommit: 'a'.repeat(40),
    buildSha256: 'b'.repeat(64),
    configSha256: configHash,
    planDirectory: join(root, 'symposium/service'),
  };
  const oldRow = {
    launchId: oldId,
    ...plan,
    state: 'retirement_uncertain',
    instanceId: null,
    controllerGeneration: 0,
    completedAt: null,
    retirementStateParent: null,
  };
  const original = {
    contract: 'sealed-macos-restricted-path-lsof-v1',
    operation,
    lock,
    transition: { id: operation, target: plan.sourceCommit },
    plan,
    row: oldRow,
    sourceContractVerified: true,
    sealedSystem: true,
    lookupPathsAbsent: true,
    restrictedProbeError: 'ENOENT',
    job: { pid: null, state: 'not running', runs: 1, lastExitCode: 1 },
    originalOwnerAbsent: true,
    gatewayDirectories: [],
    attestationAbsent: true,
    sessionArtifactLedgerAbsent: true,
    eventCounts: [0, 0, 0, 0],
    artifactSchemaEmpty: true,
    containers: [],
    volumes: [],
    configSha256: configHash,
    serviceFiles: {},
    workspaceFiles: {},
    gatewayFiles: {},
    registryFiles: {},
  };
  write(join(oldArchive, 'audit.json'), original);
  const old = {
    version: 1,
    operation,
    archive: oldArchive,
    auditSha256: hash(JSON.stringify(original)),
    classification: 'pre_native_refused',
    originalLaunchId: oldId,
  };
  const qualified = {
    launchId: oldId,
    classification: 'pre_native_refused',
    recordJson: JSON.stringify(oldRow),
    auditSha256: old.auditSha256,
    archive: oldArchive,
  };
  const nextPlan = {
      ...plan,
      sourceCommit: '1'.repeat(40),
      configPath: join(root, 'symposium/settings/owned-host.json'),
    },
    row = { ...oldRow, ...nextPlan, launchId };
  delete row.configPath;
  const s = {
    ...original,
    contract: 'native-ed25519-before-store-v1',
    plan: nextPlan,
    row,
    activation: { operation, target: nextPlan.sourceCommit },
    nativeMandatoryGateVerified: true,
    gatewayMaterialVerified: true,
    signingAlgorithm: 'rsa',
    publicAlgorithm: 'rsa',
    tokenCacheAbsent: true,
    gatewayDatabaseAbsent: true,
    qualified: [qualified],
    previousRecovery: old,
    previousAuditSha256: old.auditSha256,
    registrationSha256: 'f'.repeat(64),
  };
  write(join(archive, 'audit.json'), s);
  write(join(archive, 'previous-cold-recovery.json'), old);
  write(join(archive, 'cold-recovery.json'), old);
  writeFileSync(join(archive, 'original-config.json'), raw, { mode: 0o600 });
  const fresh = installFreshKeyConfiguration(root, nextPlan.configPath, raw, launchId),
    receipt = {
      version: 2,
      operation,
      archive,
      classification: 'pre_resource_refused',
      nativeRetirement: false,
      serviceControl: false,
      modelCalls: 0,
      productionActions: [],
      originalLaunchId: launchId,
      originalSource: nextPlan.sourceCommit,
      originalRegistrationSha256: s.registrationSha256,
      auditSha256: hash(JSON.stringify(s)),
      ...fresh,
    };
  const db = new Database(join(root, 'registry/staging.db'));
  db.exec(
    'CREATE TABLE policy(id INTEGER,capacity INTEGER);INSERT INTO policy VALUES(1,1);CREATE TABLE launches(launchId TEXT);CREATE TABLE qualified_cold_refusals(launchId TEXT,classification TEXT,recordJson TEXT,auditSha256 TEXT,archive TEXT)',
  );
  const insert = db.prepare('INSERT INTO qualified_cold_refusals VALUES(?,?,?,?,?)');
  insert.run(...Object.values(qualified));
  insert.run(launchId, 'pre_resource_refused', JSON.stringify(row), receipt.auditSha256, archive);
  db.close();
  return { root, archive, oldArchive, receipt, write };
}
it('verifies both preserved histories and exact new key/config bytes while retaining the lock', async () => {
  const f = boundFixture();
  try {
    const result = await verifyKeyRecovery(f.root, f.receipt, false);
    expect(result.recovery).toEqual(f.receipt);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
it.each([
  'old archive',
  'new archive',
  'configuration',
  'fresh key',
  'original lock',
  'qualified history',
])('fences changed %s and keeps the original lock', async (kind) => {
  const f = boundFixture();
  try {
    if (kind === 'old archive' || kind === 'new archive')
      writeFileSync(
        join(kind === 'old archive' ? f.oldArchive : f.archive, 'registry', 'unexpected'),
        'x',
        { mode: 0o600 },
      );
    else if (kind === 'configuration')
      f.write(join(f.root, 'symposium/settings/owned-host.json'), {});
    else if (kind === 'fresh key') writeFileSync(f.receipt.freshKeys.publicKey.path, 'changed');
    else if (kind === 'original lock') f.write(join(f.root, 'service/deployment.lock'), {});
    else {
      const db = new Database(join(f.root, 'registry/staging.db'));
      db.exec(
        "UPDATE qualified_cold_refusals SET classification='retired' WHERE classification='pre_resource_refused'",
      );
      db.close();
    }
    await expect(verifyKeyRecovery(f.root, f.receipt, false)).rejects.toThrow();
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
