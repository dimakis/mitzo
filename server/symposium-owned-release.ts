import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** Static release preparation only. Never imports the host/bootstrap/auth owners. */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { OwnedSymposiumConfigSchema } from './symposium-owned-config-schema.js';
import { reviewedSymposiumOwnedRuntime } from './symposium-owned-runtime-contract.js';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fail(): never {
  throw Error(
    'Owned release preparation refused; inspect explicit fresh configuration and reviewed build',
  );
}
function pathMetadata(path: string, directory = false, privateMode = false) {
  if (!isAbsolute(path) || realpathSync(path) !== path) fail();
  const stat = lstatSync(path);
  if (
    stat.uid !== process.getuid?.() ||
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    stat.mode & (privateMode ? 0o077 : 0o022)
  )
    fail();
  return stat;
}
function bytes(path: string, max = 16 * 1024 * 1024) {
  pathMetadata(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > max) fail();
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      data.length > max ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail();
    return data;
  } finally {
    closeSync(fd);
  }
}
const fileDigest = (path: string) => sha(bytes(path, 512 * 1024 * 1024));
function tree(path: string) {
  pathMetadata(path, true);
  const entries: string[] = [];
  let total = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const p = join(directory, name),
        stat = lstatSync(p);
      if (stat.isDirectory()) {
        pathMetadata(p, true);
        visit(p);
      } else {
        total += stat.size;
        if (total > 512 * 1024 * 1024) fail();
        entries.push(relative(path, p) + ':' + fileDigest(p));
      }
    }
  };
  visit(path);
  return sha(entries.join('\n'));
}
function verifyCompiledResolution(root: string) {
  const entries: Record<string, string> = {
    '@mitzo/protocol': 'packages/protocol/dist/index.js',
    '@mitzo/protocol/event-store': 'packages/protocol/dist/event-store.js',
    '@mitzo/harness': 'packages/harness/dist/index.js',
    '@mitzo/client': 'packages/client/dist/index.js',
    '@mitzo/client/hooks': 'packages/client/dist/hooks/index.js',
  };
  const origins = [
    'dist/symposium-custodian-main.js',
    'packages/protocol/dist/index.js',
    'packages/harness/dist/index.js',
    'packages/client/dist/index.js',
  ];
  const input = origins.flatMap((origin) =>
    Object.keys(entries).map((specifier) => ({
      specifier,
      parent: pathToFileURL(join(root, origin)).href,
    })),
  );
  const result = execFileSync(
    process.execPath,
    [
      '--experimental-import-meta-resolve',
      '--input-type=module',
      '-e',
      "let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.stringify(JSON.parse(text).map(x=>import.meta.resolve(x.specifier,x.parent))));",
    ],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const resolved: unknown = JSON.parse(result);
  if (!Array.isArray(resolved) || resolved.length !== input.length) fail();
  for (let i = 0; i < input.length; i++) {
    const expected = join(root, entries[input[i].specifier]);
    pathMetadata(expected);
    if (typeof resolved[i] !== 'string' || fileURLToPath(resolved[i]) !== expected) fail();
  }
}
export interface OwnedReleaseInput {
  releaseRoot: string;
  configPath: string;
  repositoryPath: string;
  planDirectory: string;
}
export interface OwnedReleasePlan extends OwnedReleaseInput {
  schemaVersion: 1;
  mode: 'owned-custodian';
  entry: 'dist/symposium-custodian-main.js';
  configSha256: string;
  appHome: string;
  sourceCommit: string;
  sourceTree: string;
  buildSha256: string;
  inputsSha256: string;
  runtime: ReturnType<typeof reviewedSymposiumOwnedRuntime>['build'];
  admissionVerified: false;
}
function inspect(input: OwnedReleaseInput, digest: (path: string) => string) {
  pathMetadata(input.releaseRoot, true);
  if (
    readdirSync(input.releaseRoot).some((name) => name.startsWith('.env')) ||
    existsSync(join(input.releaseRoot, 'certs'))
  )
    fail();
  pathMetadata(input.planDirectory, true, true);
  pathMetadata(input.repositoryPath, true, true);
  pathMetadata(input.configPath, false, true);
  if (readdirSync(input.repositoryPath).length) fail();
  const sourceGuard = execFileSync(
    '/bin/bash',
    [join(input.releaseRoot, 'scripts/assert-deployable.sh'), '--offline'],
    {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: input.planDirectory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const sourceCommit = /^DEPLOYMENT_COMMIT=([a-f0-9]{40})$/m.exec(sourceGuard)?.[1];
  const sourceTree = /^source_tree=([a-f0-9]{40})$/m.exec(
    bytes(join(input.releaseRoot, 'release.txt'), 65536).toString('utf8'),
  )?.[1];
  if (!sourceCommit || !sourceTree) fail();
  const raw = bytes(input.configPath, 1024 * 1024),
    config = OwnedSymposiumConfigSchema.parse(JSON.parse(raw.toString('utf8')));
  const reviewed = reviewedSymposiumOwnedRuntime(config.gateway.workloadImage).build;
  if (
    config.gateway.cliSha256 !== reviewed.cliSha256 ||
    config.gateway.executableSha256 !== reviewed.gatewaySha256 ||
    config.gateway.sandboxRuntimeImage !== reviewed.sandboxRuntimeImage ||
    config.gateway.supervisorImage !== reviewed.supervisorImage ||
    digest(config.gateway.cliExecutable) !== reviewed.cliSha256 ||
    digest(config.gateway.executable) !== reviewed.gatewaySha256
  )
    fail();
  if (
    config.artifacts.length ||
    existsSync(config.attestationPath) ||
    !config.runtime.createDetached ||
    config.runtime.sandboxIdLength !== 13
  )
    fail();
  pathMetadata(config.gateway.stateParent, true, true);
  if (readdirSync(config.gateway.stateParent).length) fail();
  pathMetadata(config.podman.environment.HOME, true, true);
  for (const path of [...Object.values(config.gateway.tls), ...Object.values(config.gateway.jwt)])
    pathMetadata(path, false, true);
  pathMetadata(config.gateway.systemCaBundle);
  pathMetadata(config.podman.executable);
  const profiles = config.providerProfiles.map((profile) => {
    const actual = digest(profile.path);
    if (actual !== profile.sha256) fail();
    return actual;
  });
  for (const profile of config.personal.workProfiles) {
    if (profile.provider === 'anthropic-vertex') {
      if (!Object.hasOwn(reviewed.nativeArtifacts, '/usr/local/bin/claude')) fail();
      pathMetadata(profile.credentialRef, false, true);
      if (
        profiles.filter(
          (x) => x === 'a1aac4f9e3710bba3aaa32c1787d588de6ec3c422198267077db11f1f1e2039d',
        ).length !== 1
      )
        fail();
    }
  }
  // Credential/TLS contents are deliberately not read. Their owners validate them at explicit launch.
  const inputsSha256 = sha(
    JSON.stringify({
      policy: digest(config.runtime.policy),
      seed: tree(config.runtime.seed),
      profiles,
    }),
  );
  for (const name of [
    'dist/symposium-custodian-main.js',
    'dist/symposium-owned-runtime-contract.js',
    'frontend/dist/index.html',
    'packages/protocol/dist/index.js',
    'packages/harness/dist/index.js',
    'packages/client/dist/index.js',
  ])
    pathMetadata(join(input.releaseRoot, name));
  verifyCompiledResolution(input.releaseRoot);
  const buildSha256 = sha(
    JSON.stringify(
      [
        'dist',
        'frontend/dist',
        'packages/protocol/dist',
        'packages/harness/dist',
        'packages/client/dist',
        'scripts',
      ].map((p) => tree(join(input.releaseRoot, p))),
    ),
  );
  return {
    sourceCommit,
    sourceTree,
    configSha256: sha(raw),
    appHome: config.podman.environment.HOME,
    buildSha256,
    inputsSha256,
    runtime: reviewed,
  };
}
export function prepareOwnedRelease(
  input: OwnedReleaseInput,
  digest = fileDigest,
): OwnedReleasePlan {
  return {
    ...input,
    ...inspect(input, digest),
    schemaVersion: 1,
    mode: 'owned-custodian',
    entry: 'dist/symposium-custodian-main.js',
    admissionVerified: false,
  };
}
export function verifyOwnedRelease(plan: OwnedReleasePlan, digest = fileDigest): void {
  if (
    plan.schemaVersion !== 1 ||
    plan.mode !== 'owned-custodian' ||
    plan.entry !== 'dist/symposium-custodian-main.js' ||
    plan.admissionVerified !== false
  )
    fail();
  const actual = inspect(plan, digest);
  for (const key of [
    'sourceCommit',
    'sourceTree',
    'configSha256',
    'appHome',
    'buildSha256',
    'inputsSha256',
    'runtime',
  ] as const)
    if (JSON.stringify(plan[key]) !== JSON.stringify(actual[key])) fail();
}
export function claimOwnedLaunch(plan: OwnedReleasePlan, digest = fileDigest) {
  verifyOwnedRelease(plan, digest);
  const accounts = join(plan.planDirectory, 'empty-accounts.json');
  pathMetadata(accounts, false, true);
  if (bytes(accounts, 16).toString('utf8') !== '[]\n') fail();
  const marker = join(plan.planDirectory, 'launch.intent');
  // O_EXCL refuses existing regular files, dangling symlinks and previous uncertain starts alike.
  const fd = openSync(
    marker,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        schemaVersion: 1,
        configSha256: plan.configSha256,
        buildSha256: plan.buildSha256,
        entry: plan.entry,
      }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(marker), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  // Failure here retains the durable intent; no automatic erase or retry.
  verifyOwnedRelease(plan, digest);
}
export function readOwnedReleasePlan(path: string): OwnedReleasePlan {
  pathMetadata(path, false, true);
  return JSON.parse(bytes(path, 1024 * 1024).toString('utf8'));
}
export function renderOwnedPlist(plan: OwnedReleasePlan, node: string) {
  if (!isAbsolute(node)) fail();
  const xml = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.mitzo.owned-custodian</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(plan.releaseRoot, 'scripts/start-owned-custodian.mjs'))}</string><string>${xml(join(plan.planDirectory, 'owned-release.json'))}</string></array><key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string><key>DOTENV_CONFIG_PATH</key><string>/dev/null</string></dict><key>WorkingDirectory</key><string>${xml(plan.releaseRoot)}</string><key>KeepAlive</key><false/><key>RunAtLoad</key><false/><key>ExitTimeOut</key><integer>180</integer></dict></plist>\n`;
}
