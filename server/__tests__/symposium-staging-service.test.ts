import { afterEach, expect, it } from 'vitest';
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
import { tmpdir } from 'node:os';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';
import {
  prepareStagingService,
  readStagingOperatorEnvironment,
  stagingServiceLabel,
} from '../symposium-staging-service.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
