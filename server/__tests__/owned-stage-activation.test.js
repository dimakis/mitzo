import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createFreshActivationIntent,
  verifyFreshActivationBinding,
} from '../../scripts/lib/owned-stage-activation.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function writeJson(path, value) {
  const text = JSON.stringify(value) + '\n';
  writeFileSync(path, text, { mode: 0o600 });
  return hash(text);
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-activation-')));
  roots.push(root);
  const source = join(root, 'source');
  const owned = join(root, 'symposium/service');
  const archive = join(root, 'archive');
  for (const path of [
    source,
    owned,
    archive,
    join(root, 'symposium/settings'),
    join(root, 'service'),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const configPath = join(root, 'config.json');
  const proposalSha256 = writeJson(configPath, { personal: {} });
  const controllerReceiptSha256 = writeJson(join(source, 'staging-release.json'), {
    source: 'reviewed',
  });
  writeJson(join(root, 'symposium/settings/staging-registration.json'), { port: 3190 });
  for (const name of [
    'owned-release.json',
    'staging-custodian.plist',
    'staging-operator.json',
    'empty-accounts.json',
  ])
    writeJson(join(owned, name), { file: name });
  const p = {
    operation: '4b5af3ef-3ff5-4595-b66b-65b6702df011',
    target: 'a'.repeat(40),
    archive,
    proposalSha256,
    controllerReceiptSha256,
    live: { plan: { configPath } },
  };
  const lock = { planSha256: writeJson(join(archive, 'plan.json'), p) };
  const plan = {
    releaseRoot: source,
    sourceCommit: p.target,
    acceptedMainBaseline: p.target,
    configSha256: proposalSha256,
    configPath,
  };
  const intent = createFreshActivationIntent(root, source, p, plan);
  lock.freshActivationSha256 = writeJson(join(archive, 'fresh-activation.json'), intent);
  lock.startAttemptSha256 = writeJson(join(archive, 'start-attempt.json'), intent);
  writeJson(join(root, 'service/com.mitzo.staging.plist'), { file: 'staging-custodian.plist' });
  return { root, source, owned, p, plan, lock, intent };
}

it('binds the complete four-input activation and one original start attempt', () => {
  const f = fixture();
  expect(Object.keys(f.intent.inputs)).toEqual([
    'owned-release.json',
    'staging-custodian.plist',
    'staging-operator.json',
    'empty-accounts.json',
  ]);
  expect(verifyFreshActivationBinding(f.root, f.source, f.p, f.plan, f.lock)).toEqual(f.intent);
  expect(
    verifyFreshActivationBinding(f.root, f.source, f.p, f.plan, f.lock, {
      started: true,
      registered: true,
    }),
  ).toEqual(f.intent);
});

it.each([
  'empty-inputs',
  'missing-input',
  'extra-input',
  'target',
  'operation',
  'config',
  'controller',
  'registration',
  'plan',
  'extra-field',
])('rejects a rewritten %s intent even when its lock digest was refreshed', (kind) => {
  const f = fixture();
  const intent = globalThis.structuredClone(f.intent);
  if (kind === 'empty-inputs') intent.inputs = {};
  if (kind === 'missing-input') delete intent.inputs['empty-accounts.json'];
  if (kind === 'extra-input') intent.inputs['unexpected'] = '0'.repeat(64);
  if (kind === 'target') intent.target = 'b'.repeat(40);
  if (kind === 'operation') intent.operation = 'wrong';
  if (kind === 'config') intent.configSha256 = '0'.repeat(64);
  if (kind === 'controller') intent.controllerReceiptSha256 = '0'.repeat(64);
  if (kind === 'registration') intent.registrationSha256 = '0'.repeat(64);
  if (kind === 'plan') intent.planSha256 = '0'.repeat(64);
  if (kind === 'extra-field') intent.unexpected = true;
  f.lock.freshActivationSha256 = writeJson(join(f.p.archive, 'fresh-activation.json'), intent);
  expect(() => verifyFreshActivationBinding(f.root, f.source, f.p, f.plan, f.lock)).toThrow();
});

it.each([
  'owned-release.json',
  'staging-custodian.plist',
  'staging-operator.json',
  'empty-accounts.json',
])('rejects current prepared %s drift before service control', (name) => {
  const f = fixture();
  writeJson(join(f.owned, name), { changed: true });
  expect(() => verifyFreshActivationBinding(f.root, f.source, f.p, f.plan, f.lock)).toThrow();
});

it.each([
  'config',
  'controller',
  'registration',
  'archive-plan',
  'canonical-plist',
  'start-attempt',
  'missing-start-attempt',
  'intent-lock',
])('rejects %s drift before acknowledgement', (kind) => {
  const f = fixture();
  if (kind === 'config') writeJson(f.p.live.plan.configPath, {});
  if (kind === 'controller') writeJson(join(f.source, 'staging-release.json'), {});
  if (kind === 'registration')
    writeJson(join(f.root, 'symposium/settings/staging-registration.json'), {});
  if (kind === 'archive-plan') writeJson(join(f.p.archive, 'plan.json'), {});
  if (kind === 'canonical-plist') writeJson(join(f.root, 'service/com.mitzo.staging.plist'), {});
  if (kind === 'start-attempt') writeJson(join(f.p.archive, 'start-attempt.json'), {});
  if (kind === 'missing-start-attempt') rmSync(join(f.p.archive, 'start-attempt.json'));
  if (kind === 'intent-lock') f.lock.freshActivationSha256 = '0'.repeat(64);
  expect(() =>
    verifyFreshActivationBinding(f.root, f.source, f.p, f.plan, f.lock, {
      started: true,
      registered: true,
    }),
  ).toThrow();
});

it.each(['releaseRoot', 'sourceCommit', 'acceptedMainBaseline', 'configSha256', 'configPath'])(
  'rejects the prepared release %s mismatch',
  (field) => {
    const f = fixture();
    f.plan[field] = 'unrelated';
    expect(() => createFreshActivationIntent(f.root, f.source, f.p, f.plan)).toThrow();
  },
);
