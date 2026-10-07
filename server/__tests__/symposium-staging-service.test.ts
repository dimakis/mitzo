import { afterEach, expect, it, vi } from 'vitest';
const operator = vi.hoisted(() => ({ home: undefined as string | undefined }));
vi.mock('node:os', async (load) => {
  const actual = await load<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({
      ...actual.userInfo(),
      ...(operator.home ? { homedir: operator.home } : {}),
    }),
  };
});
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';
import {
  prepareStagingService,
  prepareCanonicalStagingService,
  assertCanonicalStagingService,
  canonicalStagingRoot,
  readStagingOperatorEnvironment,
  stagingServiceLabel,
} from '../symposium-staging-service.js';

const roots: string[] = [];
afterEach(() => {
  operator.home = undefined;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'staging-service-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const planDirectory = join(root, 'plan');
  mkdirSync(planDirectory, { mode: 0o700 });
  const plan = {
    planDirectory,
    releaseRoot: join(root, 'release'),
    repositoryPath: join(root, 'repo'),
    appHome: join(root, 'home'),
    configPath: join(root, 'host.json'),
  } as OwnedReleasePlan;
  const registrationPath = join(root, 'registration.json');
  writeFileSync(registrationPath, '{}', { mode: 0o600 });
  return { root, plan, registrationPath };
}
it('prepares a unique manually started launchd job without exposing authentication or starting a process', () => {
  const f = fixture();
  const prepared = prepareStagingService(f.plan, f.registrationPath, process.execPath, 19994);
  const plist = readFileSync(prepared.plistPath, 'utf8');
  const settings = JSON.parse(readFileSync(prepared.operatorPath, 'utf8'));
  expect(plist).toContain('<key>RunAtLoad</key><false/>');
  expect(plist).toContain('<key>KeepAlive</key><false/>');
  expect(plist).toContain('<key>ExitTimeOut</key><integer>180</integer>');
  expect(plist).toContain('start-staging-custodian.mjs');
  expect(plist).toContain(prepared.operatorPath);
  expect(plist).not.toContain(settings.AUTH_PASSPHRASE);
  expect(plist).not.toContain(settings.AUTH_SECRET);
  expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(false);
  expect(prepared.label).toBe(stagingServiceLabel(f.plan));
  expect(prepared.label).not.toBe(stagingServiceLabel(fixture().plan));
  const env = readStagingOperatorEnvironment(f.plan, prepared.operatorPath, {
    GH_TOKEN: 'must-not-pass',
    AUTH_PASSPHRASE: 'ambient',
    AUTH_SECRET: 'ambient',
  });
  expect(env.AUTH_PASSPHRASE).toBe(settings.AUTH_PASSPHRASE);
  expect(env.PORT).toBe('19994');
  expect(env.MITZO_BIND_HOST).toBe('127.0.0.1');
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.MITZO_SYMPOSIUM_OWNED_HOST_CONFIG).toBe(f.plan.configPath);
  expect(() =>
    prepareStagingService(f.plan, f.registrationPath, process.execPath, 19994),
  ).toThrow();
});
it.each(['public', 'symlink', 'hardlink', 'foreign-path', 'extra-field', 'loader'])(
  'refuses %s operator inputs before a launch can claim ownership',
  (kind) => {
    const f = fixture();
    const prepared = prepareStagingService(f.plan, f.registrationPath, process.execPath, 19994);
    let path = prepared.operatorPath;
    let ambient: NodeJS.ProcessEnv = {};
    if (kind === 'public') chmodSync(path, 0o644);
    if (kind === 'symlink') {
      const original = join(f.root, 'original');
      writeFileSync(original, readFileSync(path), { mode: 0o600 });
      rmSync(path);
      symlinkSync(original, path);
    }
    if (kind === 'hardlink') linkSync(path, join(f.root, 'alias'));
    if (kind === 'foreign-path') path = f.registrationPath;
    if (kind === 'extra-field') {
      const d = JSON.parse(readFileSync(path, 'utf8'));
      d.GH_TOKEN = 'must-not-pass';
      writeFileSync(path, JSON.stringify(d));
    }
    if (kind === 'loader') ambient = { NODE_OPTIONS: '--import arbitrary-loader' };
    expect(() => readStagingOperatorEnvironment(f.plan, path, ambient)).toThrow();
    expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(false);
  },
);
it.each([0, 3100, 3101, 65536, 19994.5])(
  'refuses invalid or production port %s without writing settings',
  (port) => {
    const f = fixture();
    expect(() =>
      prepareStagingService(f.plan, f.registrationPath, process.execPath, port),
    ).toThrow();
    expect(existsSync(join(f.plan.planDirectory, 'staging-operator.json'))).toBe(false);
  },
);
it('refuses overlapping registration and an existing launch intent', () => {
  const f = fixture();
  expect(() =>
    prepareStagingService(
      f.plan,
      join(f.plan.planDirectory, 'staging-operator.json'),
      process.execPath,
      19994,
    ),
  ).toThrow();
  writeFileSync(join(f.plan.planDirectory, 'launch.intent'), 'uncertain', { mode: 0o600 });
  expect(() =>
    prepareStagingService(f.plan, f.registrationPath, process.execPath, 19994),
  ).toThrow();
});

it.each(['owner.stdout.log', 'owner.stderr.log'])(
  'refuses a registration or pre-existing output at %s without creating service files',
  (name) => {
    const f = fixture();
    const logPath = join(f.plan.planDirectory, name);
    writeFileSync(logPath, '{"audit":"preserve"}', { mode: 0o600 });
    for (const registrationPath of [logPath, f.registrationPath]) {
      expect(() =>
        prepareStagingService(f.plan, registrationPath, process.execPath, 19994),
      ).toThrow();
      expect(readFileSync(logPath, 'utf8')).toBe('{"audit":"preserve"}');
      expect(existsSync(join(f.plan.planDirectory, 'staging-operator.json'))).toBe(false);
      expect(existsSync(join(f.plan.planDirectory, 'staging-custodian.plist'))).toBe(false);
    }
  },
);

function canonicalFixture() {
  const f = fixture();
  operator.home = f.root;
  const root = join(f.root, '.local/share/mitzo-staging');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const planDirectory = join(root, 'symposium/service');
  mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'symposium/settings'), { mode: 0o700 });
  const sourceCommit = 'a'.repeat(40);
  const plan = {
    ...f.plan,
    sourceCommit,
    planDirectory,
    releaseRoot: join(root, 'releases', sourceCommit.slice(0, 12)),
    repositoryPath: join(root, 'symposium/workspace'),
    appHome: join(root, 'symposium/home'),
    configPath: join(root, 'symposium/settings/owned-host.json'),
  };
  const registrationPath = join(root, 'symposium/settings/staging-registration.json');
  const registration = {
    registryDirectory: join(root, 'registry'),
    capacity: 1,
    ownerChat: 'canonical-stage',
    purpose: 'Symposium',
    retentionReason: 'shared development stage',
    reviewAfter: Date.now() + 86400000,
  };
  writeFileSync(registrationPath, JSON.stringify(registration), { mode: 0o600 });
  return { root, plan, registrationPath, registration };
}
it('prepares exactly one canonical Symposium service identity without starting it', () => {
  const f = canonicalFixture();
  const result = prepareCanonicalStagingService(
    f.plan,
    f.registrationPath,
    process.execPath,
    f.root,
  );
  const plist = readFileSync(result.plistPath, 'utf8');
  expect(result.label).toBe('com.mitzo.staging');
  expect(JSON.parse(readFileSync(result.operatorPath, 'utf8')).PORT).toBe('3190');
  expect(plist).toContain('<key>KeepAlive</key><false/>');
  expect(plist).toContain('<string>--canonical</string>');
  expect(plist).toContain('<key>RunAtLoad</key><false/>');
  expect(existsSync(join(f.plan.planDirectory, 'launch.intent'))).toBe(false);
  f.registration.capacity = 2;
  writeFileSync(f.registrationPath, JSON.stringify(f.registration));
  expect(() => assertCanonicalStagingService(f.plan, f.registrationPath, f.root)).toThrow();
});
it.each([
  'capacity',
  'registry',
  'repository',
  'home',
  'config',
  'release',
  'commit',
  'registration-path',
])('refuses canonical staging %s drift before creating service files', (kind) => {
  const f = canonicalFixture();
  if (kind === 'capacity') f.registration.capacity = 2;
  if (kind === 'registry') f.registration.registryDirectory = join(f.root, 'other-registry');
  if (kind === 'repository') f.plan.repositoryPath = join(f.root, 'other-workspace');
  if (kind === 'home') f.plan.appHome = '/private/production';
  if (kind === 'config') f.plan.configPath = join(f.root, 'other-config.json');
  if (kind === 'release') f.plan.releaseRoot = '/private/production';
  if (kind === 'commit') f.plan.sourceCommit = 'main';
  writeFileSync(f.registrationPath, JSON.stringify(f.registration));
  let path = f.registrationPath;
  if (kind === 'registration-path') {
    path = join(f.root, 'another.json');
    writeFileSync(path, JSON.stringify(f.registration), { mode: 0o600 });
  }
  expect(() => prepareCanonicalStagingService(f.plan, path, process.execPath, f.root)).toThrow();
  expect(existsSync(join(f.plan.planDirectory, 'staging-operator.json'))).toBe(false);
});

it('derives the canonical root from the operator identity despite ambient HOME', () => {
  const old = process.env.HOME;
  try {
    process.env.HOME = '/private/production';
    expect(canonicalStagingRoot()).toBe(join(userInfo().homedir, '.local/share/mitzo-staging'));
  } finally {
    if (old === undefined) delete process.env.HOME;
    else process.env.HOME = old;
  }
});
it('retains the validated canonical registration when the file is replaced', () => {
  const f = canonicalFixture();
  const checked = assertCanonicalStagingService(f.plan, f.registrationPath, f.root);
  f.registration.capacity = 2;
  f.registration.registryDirectory = join(f.root, 'another-registry');
  writeFileSync(f.registrationPath, JSON.stringify(f.registration));
  expect(checked.capacity).toBe(1);
  expect(checked.registryDirectory).toBe(join(f.root, 'registry'));
  expect(() => assertCanonicalStagingService(f.plan, f.registrationPath, f.root)).toThrow();
});

it('refuses ordinary trial preparation for a canonical plan before creating files', () => {
  const f = canonicalFixture();
  expect(() => prepareStagingService(f.plan, f.registrationPath, process.execPath, 19994)).toThrow(
    /canonical/i,
  );
  expect(existsSync(join(f.plan.planDirectory, 'staging-operator.json'))).toBe(false);
});

it('refuses a private alternate root before writing canonical service credentials', () => {
  const f = canonicalFixture();
  operator.home = join(f.root, 'different-operator-home');
  expect(() => assertCanonicalStagingService(f.plan, f.registrationPath, f.root)).toThrow();
  expect(() =>
    prepareCanonicalStagingService(f.plan, f.registrationPath, process.execPath, f.root),
  ).toThrow();
  expect(existsSync(join(f.plan.planDirectory, 'staging-operator.json'))).toBe(false);
  expect(existsSync(join(f.plan.planDirectory, 'staging-custodian.plist'))).toBe(false);
});
