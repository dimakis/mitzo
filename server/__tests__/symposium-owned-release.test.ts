import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
  linkSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  prepareOwnedRelease,
  verifyOwnedRelease,
  verifyRetainedOwnedRelease,
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
    'release/scripts',
    'release/node_modules/@mitzo',
    'release/packages/client/dist/hooks',
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
    'scripts/start-owned-custodian.mjs',
    'scripts/prepare-owned-custodian-release.mjs',
    'dist/symposium-custodian-main.js',
    'dist/symposium-owned-runtime-contract.js',
    'frontend/dist/index.html',
    'packages/protocol/dist/index.js',
    'packages/harness/dist/index.js',
    'packages/client/dist/index.js',
  ])
    writeFileSync(join(root, 'release', p), 'reviewed build');
  for (const pkg of ['protocol', 'harness', 'client']) {
    const exports: Record<string, string> = { '.': './dist/index.js' };
    if (pkg === 'protocol') {
      exports['./event-store'] = './dist/event-store.js';
      writeFileSync(join(root, 'release/packages/protocol/dist/event-store.js'), 'compiled');
    }
    if (pkg === 'client') {
      exports['./hooks'] = './dist/hooks/index.js';
      writeFileSync(join(root, 'release/packages/client/dist/hooks/index.js'), 'compiled');
    }
    writeFileSync(
      join(root, 'release/packages', pkg, 'package.json'),
      JSON.stringify({ name: '@mitzo/' + pkg, type: 'module', exports }),
    );
    symlinkSync(
      join(root, 'release/packages', pkg),
      join(root, 'release/node_modules/@mitzo', pkg),
    );
  }
  writeFileSync(
    join(root, 'release/scripts/assert-deployable.sh'),
    readFileSync('scripts/assert-deployable.sh'),
  );
  writeFileSync(
    join(root, 'release/.gitignore'),
    'node_modules/\ndist/\nfrontend/dist/\npackages/*/dist/\nrelease.txt\n',
  );
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: join(root, 'release'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Offline']);
  git(['config', 'user.email', 'offline@example.invalid']);
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const head = git(['rev-parse', 'HEAD']),
    sourceTree = git(['rev-parse', 'HEAD^{tree}']);
  git(['update-ref', 'refs/remotes/origin/main', head]);
  git(['checkout', '--detach', '-q']);
  writeFileSync(
    join(root, 'release/release.txt'),
    `source_commit=${head}\nbase_main=${head}\nsource_tree=${sourceTree}\n`,
  );
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
  writeFileSync(join(root, 'plan', 'empty-accounts.json'), '[]\n', { mode: 0o600 });
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
it('binds launch script bytes and rejects substituted ordinary account catalog before claiming', () => {
  const f = fixture(),
    plan = prepareOwnedRelease(f.input, f.digest);
  writeFileSync(join(f.input.releaseRoot, 'scripts/start-owned-custodian.mjs'), 'mutated');
  expect(() => verifyOwnedRelease(plan, f.digest)).toThrow();
  const g = fixture(),
    other = prepareOwnedRelease(g.input, g.digest);
  writeFileSync(join(g.input.planDirectory, 'empty-accounts.json'), '[{"provider":"openai"}]');
  expect(() => claimOwnedLaunch(other, g.digest)).toThrow();
});
it('rejects inherited state and all nonempty repository content for unsupported migration', () => {
  const f = fixture();
  writeFileSync(join(f.input.repositoryPath, 'ordinary-history.db'), 'old');
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});
it('validates Vertex reference metadata without reading credential or TLS material', () => {
  const f = fixture(),
    reference = join(f.root, 'selected-adc');
  writeFileSync(reference, 'DO_NOT_READ', { mode: 0o600 });
  Object.assign(f.config.personal, {
    workProfiles: [
      {
        id: 'work',
        label: 'Work',
        provider: 'anthropic-vertex',
        credentialRef: reference,
        expectedPrincipal: 'operator@example.com',
        projectId: 'project-example',
        region: 'global',
        models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
      },
    ],
  });
  f.config.providerProfiles[0].sha256 =
    'a1aac4f9e3710bba3aaa32c1787d588de6ec3c422198267077db11f1f1e2039d';
  f.save();
  const observed: string[] = [];
  const digest = (path: string) => {
    observed.push(path);
    return path === f.config.providerProfiles[0].path
      ? f.config.providerProfiles[0].sha256
      : f.digest(path);
  };
  expect(prepareOwnedRelease(f.input, digest).admissionVerified).toBe(false);
  expect(observed).not.toContain(reference);
  for (const path of Object.values(f.config.gateway.tls)) expect(observed).not.toContain(path);
  chmodSync(reference, 0o644);
  expect(() => prepareOwnedRelease(f.input, digest)).toThrow();
});

it('rejects dotenv files before any marker is written', () => {
  const f = fixture();
  writeFileSync(join(f.input.releaseRoot, '.env.local'), 'do not read');
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});

it('rejects workspace resolution to another checkout even with the same compiled bytes', () => {
  const f = fixture(),
    foreign = fixture();
  const link = join(f.input.releaseRoot, 'node_modules/@mitzo/protocol');
  unlinkSync(link);
  symlinkSync(join(foreign.input.releaseRoot, 'packages/protocol'), link);
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});
it('rejects a branch checkout and changed release manifest without fetching or deploying', () => {
  const f = fixture();
  execFileSync('git', ['checkout', '-b', 'not-detached'], {
    cwd: f.input.releaseRoot,
    stdio: 'pipe',
  });
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});
it('revalidates the exact empty account catalog at every post-preparation boundary', () => {
  const f = fixture(),
    plan = prepareOwnedRelease(f.input, f.digest);
  unlinkSync(join(f.input.planDirectory, 'empty-accounts.json'));
  expect(() => verifyOwnedRelease(plan, f.digest)).toThrow();
});
it('accepts canonical root-owned public CA and executable metadata only', () => {
  const f = fixture();
  f.config.gateway.systemCaBundle = realpathSync('/usr/bin/env');
  f.config.podman.executable = realpathSync('/usr/bin/env');
  f.save();
  expect(prepareOwnedRelease(f.input, f.digest).admissionVerified).toBe(false);
});
it('rejects dangling attestation entries before producing a launch plan', () => {
  const f = fixture();
  symlinkSync(join(f.root, 'absent'), f.config.attestationPath);
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});
it('rejects plan directories equal to or containing fresh repository/state directories', () => {
  for (const key of ['repositoryPath', 'stateParent'] as const) {
    const f = fixture();
    const target = key === 'repositoryPath' ? f.input.repositoryPath : f.config.gateway.stateParent;
    rmSync(join(f.input.planDirectory, 'empty-accounts.json'));
    f.input.planDirectory = target;
    expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
    const g = fixture();
    if (key === 'repositoryPath') g.input.repositoryPath = join(g.input.planDirectory, 'child');
    else g.config.gateway.stateParent = join(g.input.planDirectory, 'child');
    mkdirSync(join(g.input.planDirectory, 'child'), { mode: 0o700 });
    g.save();
    expect(() => prepareOwnedRelease(g.input, g.digest)).toThrow();
  }
});
it('rejects private references and mutable directories contained in the seed before reading seed bytes', () => {
  for (const kind of ['config', 'adc', 'tls', 'jwt', 'state', 'home', 'plan'] as const) {
    const f = fixture(),
      nested = join(f.config.runtime.seed, kind);
    if (kind === 'config') {
      f.input.configPath = nested;
    } else if (kind === 'adc') {
      writeFileSync(nested, 'synthetic private bytes', { mode: 0o600 });
      Object.assign(f.config.personal, {
        workProfiles: [
          {
            id: 'work',
            label: 'Work',
            provider: 'anthropic-vertex',
            credentialRef: nested,
            expectedPrincipal: 'operator@example.com',
            projectId: 'project-example',
            region: 'global',
            models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
          },
        ],
      });
      f.config.providerProfiles[0].sha256 =
        'a1aac4f9e3710bba3aaa32c1787d588de6ec3c422198267077db11f1f1e2039d';
    } else if (kind === 'tls' || kind === 'jwt') {
      writeFileSync(nested, 'synthetic private bytes', { mode: 0o600 });
      if (kind === 'tls') f.config.gateway.tls.serverKey = nested;
      else f.config.gateway.jwt.signingKey = nested;
    } else {
      mkdirSync(nested, { mode: 0o700 });
      if (kind === 'state') f.config.gateway.stateParent = nested;
      if (kind === 'home') f.config.podman.environment.HOME = nested;
      if (kind === 'plan') f.input.planDirectory = nested;
    }
    f.save();
    if (kind === 'config') writeFileSync(nested, JSON.stringify(f.config), { mode: 0o600 });
    const digest = (path: string) =>
      kind === 'adc' && path === f.config.providerProfiles[0].path
        ? f.config.providerProfiles[0].sha256
        : f.digest(path);
    expect(() => prepareOwnedRelease(f.input, digest)).toThrow();
  }
});
it('rejects known private references used as public hashed inputs before any digest', () => {
  for (const kind of ['policy', 'profile', 'cli', 'gateway'] as const) {
    const f = fixture(),
      secret = f.config.gateway.tls.serverKey;
    if (kind === 'policy') f.config.runtime.policy = secret;
    if (kind === 'profile') f.config.providerProfiles[0].path = secret;
    if (kind === 'cli') f.config.gateway.cliExecutable = secret;
    if (kind === 'gateway') f.config.gateway.executable = secret;
    f.save();
    const observed: string[] = [];
    expect(() =>
      prepareOwnedRelease(f.input, (path) => {
        observed.push(path);
        return f.digest(path);
      }),
    ).toThrow();
    expect(observed).not.toContain(secret);
  }
});

it('rejects canonical and hard-link aliases of configured private references before hashing', () => {
  for (const link of [symlinkSync, linkSync]) {
    const f = fixture(),
      alias = join(f.root, 'public-alias');
    link(f.config.gateway.jwt.signingKey, alias);
    f.config.runtime.policy = alias;
    f.save();
    const observed: string[] = [];
    expect(() =>
      prepareOwnedRelease(f.input, (path) => {
        observed.push(path);
        return f.digest(path);
      }),
    ).toThrow();
    expect(observed).toEqual([]);
  }
});
it('rejects seed hard links to configured private files before reading their bytes', () => {
  const f = fixture();
  linkSync(f.config.gateway.tls.serverKey, join(f.config.runtime.seed, 'hardlink.pem'));
  expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
});
it('rejects overlap between every pair of mutable runtime directories', () => {
  for (let left = 0; left < 4; left++)
    for (let right = left + 1; right < 4; right++) {
      const f = fixture();
      const paths = [
        f.input.planDirectory,
        f.input.repositoryPath,
        f.config.gateway.stateParent,
        f.config.podman.environment.HOME,
      ];
      const replacement = paths[left];
      if (right === 1) f.input.repositoryPath = replacement;
      if (right === 2) f.config.gateway.stateParent = replacement;
      if (right === 3) f.config.podman.environment.HOME = replacement;
      f.save();
      expect(() => prepareOwnedRelease(f.input, f.digest)).toThrow();
    }
});
it.each(['tls', 'jwt'] as const)(
  'rejects a private %s symlink before hashing a public executable hard link to its target',
  (kind) => {
    const f = fixture();
    const target =
      kind === 'tls' ? f.config.gateway.tls.serverKey : f.config.gateway.jwt.signingKey;
    const privateLink = join(f.root, 'private-link');
    symlinkSync(target, privateLink);
    if (kind === 'tls') f.config.gateway.tls.serverKey = privateLink;
    else f.config.gateway.jwt.signingKey = privateLink;
    unlinkSync(f.config.gateway.cliExecutable);
    linkSync(target, f.config.gateway.cliExecutable);
    f.save();
    const observed: string[] = [];
    expect(() =>
      prepareOwnedRelease(f.input, (path) => {
        observed.push(path);
        return f.digest(path);
      }),
    ).toThrow();
    expect(observed).toEqual([]);
  },
);

it('checks immutable retained inputs while allowing owned state to develop without granting a fresh launch', () => {
  const f = fixture();
  const plan = prepareOwnedRelease(f.input, f.digest);
  writeFileSync(join(f.input.repositoryPath, 'task.txt'), 'owned task');
  writeFileSync(join(f.config.gateway.stateParent, 'gateway.db'), 'owned state');
  writeFileSync(f.config.attestationPath, 'runtime evidence');
  expect(() => verifyOwnedRelease(plan, f.digest)).toThrow();
  expect(() => verifyRetainedOwnedRelease(plan, f.digest)).not.toThrow();
  writeFileSync(f.config.runtime.policy, 'drift');
  expect(() => verifyRetainedOwnedRelease(plan, f.digest)).toThrow();
});
