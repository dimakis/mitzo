import { afterEach, expect, it } from 'vitest';
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  prepareOwnedRelease,
  verifyOwnedRelease,
  claimOwnedLaunch,
  renderOwnedPlist,
} from '../symposium-owned-release.js';
import { REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME as reviewed } from '../symposium-owned-runtime-contract.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-release-')));
  roots.push(root);
  for (const p of [
    'release/dist',
    'release/frontend/dist',
    'release/packages/protocol/dist',
    'release/packages/harness/dist',
    'release/packages/client/dist',
    'state',
    'repo',
    'seed',
    'home',
    'plan',
  ])
    mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  for (const p of [
    'dist/symposium-custodian-main.js',
    'dist/symposium-owned-runtime-contract.js',
    'frontend/dist/index.html',
    'packages/protocol/dist/index.js',
    'packages/harness/dist/index.js',
    'packages/client/dist/index.js',
  ])
    writeFileSync(join(root, 'release', p), 'reviewed build');
  const file = (name: string) => {
    const p = join(root, name);
    writeFileSync(p, 'synthetic', { mode: 0o600 });
    return p;
  };
  const cli = file('cli'),
    gateway = file('gateway');
  const profile = file('profile');
  const config = {
    gateway: {
      executable: gateway,
      executableSha256: reviewed.build.gatewaySha256,
      cliExecutable: cli,
      cliSha256: reviewed.build.cliSha256,
      stateParent: join(root, 'state'),
      systemCaBundle: file('ca'),
      gateway: 'fresh',
      workspace: 'fresh',
      port: 19991,
      podmanSocket: join(root, 'socket'),
      network: 'fresh',
      workloadImage: reviewed.build.image,
      sandboxRuntimeImage: reviewed.build.sandboxRuntimeImage,
      supervisorImage: reviewed.build.supervisorImage,
      tls: {
        serverCert: file('cert'),
        serverKey: file('key'),
        clientCa: file('clientca'),
        managementCert: file('managementcert'),
        managementKey: file('managementkey'),
      },
      jwt: { signingKey: file('sign'), publicKey: file('public'), kid: file('kid') },
    },
    attestationPath: join(root, 'pending.json'),
    runtime: {
      policy: file('policy'),
      seed: join(root, 'seed'),
      createDetached: true,
      sandboxIdLength: 13,
    },
    podman: {
      executable: file('podman'),
      environment: { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' },
      sandboxNamespace: '',
    },
    personal: {
      workProfiles: [],
      accountId: 'personal',
      label: 'Personal',
      selectedModel: 'gpt-5.6-luna',
      models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
    },
    artifacts: [],
    providerProfiles: [{ path: profile, sha256: hash('synthetic') }],
  };
  const configPath = join(root, 'config.json');
  const save = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  save();
  const input = {
    releaseRoot: join(root, 'release'),
    configPath,
    repositoryPath: join(root, 'repo'),
    planDirectory: join(root, 'plan'),
  };
  // Only public executable digest observation is synthetic; all file/privacy/build checks are real.
  const digest = (path: string) =>
    path === cli
      ? reviewed.build.cliSha256
      : path === gateway
        ? reviewed.build.gatewaySha256
        : hash(readFileSync(path, 'utf8'));
  return { root, config, input, save, digest };
}
it('prepares exact reviewed mode independent of disabled legacy environment and never claims admission', () => {
  const f = fixture();
  process.env.MITZO_OPENSHELL_ENABLED = '0';
  const plan = prepareOwnedRelease(f.input, f.digest);
  expect(plan.entry).toBe('dist/symposium-custodian-main.js');
  expect(plan.runtime).toEqual(reviewed.build);
  expect(plan.admissionVerified).toBe(false);
  expect(verifyOwnedRelease(plan, f.digest)).toBeUndefined();
  delete process.env.MITZO_OPENSHELL_ENABLED;
});
it.each(['cliSha256', 'gatewaySha256', 'workloadImage', 'supervisorImage', 'sandboxRuntimeImage'])(
  'rejects mixed tuple %s',
  (key) => {
    const f = fixture();
    Object.assign(f.config.gateway, { [key]: 'sha256:' + '0'.repeat(64) });
    f.save();
    expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
  },
);
it('rejects missing config, credential values, old artifact adoption and existing app state', () => {
  const f = fixture();
  expect(() =>
    prepareOwnedRelease({ ...f.input, configPath: join(f.root, 'missing') }, f.digest),
  ).toThrow();
  Object.assign(f.config, { token: 'secret' });
  f.save();
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
  delete (f.config as Record<string, unknown>).token;
  f.save();
  mkdirSync(join(f.input.repositoryPath, '.mitzo'));
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});
it('rechecks build/config before once-only durable launch and refuses relaunch', () => {
  const f = fixture(),
    plan = prepareOwnedRelease(f.input, f.digest);
  writeFileSync(join(f.input.releaseRoot, 'dist/index.js'), 'changed');
  expect(() => claimOwnedLaunch(plan, f.digest)).toThrow();
  rmSync(join(f.input.releaseRoot, 'dist/index.js'));
  claimOwnedLaunch(plan, f.digest);
  expect(() => claimOwnedLaunch(plan, f.digest)).toThrow();
});
it('rejects symlink/writable plan parent and symlink marker', () => {
  const f = fixture();
  chmodSync(f.input.planDirectory, 0o777);
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
  chmodSync(f.input.planDirectory, 0o700);
  const plan = prepareOwnedRelease(f.input, f.digest);
  symlinkSync(join(f.root, 'missing'), join(f.input.planDirectory, 'launch.intent'));
  expect(() => claimOwnedLaunch(plan, f.digest)).toThrow();
});
it('renders explicit manual custodian launch without parent restart and preserves legacy template', () => {
  const f = fixture(),
    plan = prepareOwnedRelease(f.input, f.digest);
  const plist = renderOwnedPlist(plan, process.execPath);
  expect(plist).toContain('<key>KeepAlive</key><false/>');
  expect(plist).toContain('<key>RunAtLoad</key><false/>');
  expect(plist).toContain('<key>ExitTimeOut</key><integer>180</integer>');
  expect(plist).toContain('start-owned-custodian.mjs');
  expect(readFileSync('scripts/start.sh', 'utf8')).toContain('exec node dist/index.js');
});
