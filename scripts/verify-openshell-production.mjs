#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parse } from 'dotenv';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function required(config, key) {
  const value = config[key];
  invariant(typeof value === 'string' && value.length > 0, `${key} is required`);
  return value;
}

function absoluteExisting(config, key, kind) {
  const value = required(config, key);
  invariant(isAbsolute(value), `${key} must be absolute`);
  invariant(existsSync(value), `${key} does not exist`);
  invariant(
    kind === 'file' ? statSync(value).isFile() : statSync(value).isDirectory(),
    `${key} must be a ${kind}`,
  );
  return value;
}

function splitProviders(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

const RELEASE_METADATA_PATHS = new Set([
  'infra/openshell/production-stack.lock.json',
  'infra/openshell/rollback-record.json',
]);

const TLS_CERT_RELATIVE_PATH = ['certs', 'cert.pem'];
const TLS_KEY_RELATIVE_PATH = ['certs', 'key.pem'];
const MINIMUM_TLS_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

function runtimePort(config) {
  const value = config.PORT ?? '3100';
  invariant(/^\d+$/.test(value), 'PORT must be a valid TCP port');
  const port = Number(value);
  invariant(port >= 1 && port <= 65_535, 'PORT must be a valid TCP port');
  return port;
}

function originPort(origin) {
  if (origin.port) return Number(origin.port);
  return origin.protocol === 'https:' ? 443 : 80;
}

function readTlsFile(path, label) {
  invariant(existsSync(path), `${label} does not exist`);
  invariant(statSync(path).isFile(), `${label} must be a file`);
  try {
    return readFileSync(path);
  } catch {
    throw new Error(`${label} is not readable`);
  }
}

/**
 * The server intentionally has one TLS configuration surface: the certificate
 * and key under the checkout's `certs/` directory. Keep the release preflight
 * pointed at those exact files so it cannot approve a different pair than the
 * HTTPS server will load on restart.
 */
export function verifyReleaseTls(
  config,
  { root = repoRoot, now = Date.now(), minimumValidityMs = MINIMUM_TLS_VALIDITY_MS } = {},
) {
  const publicOrigin = new URL(required(config, 'MITZO_PUBLIC_ORIGIN'));
  const certPath = resolve(root, ...TLS_CERT_RELATIVE_PATH);
  const keyPath = resolve(root, ...TLS_KEY_RELATIVE_PATH);
  const certificatePem = readTlsFile(certPath, 'TLS certificate');
  const privateKeyPem = readTlsFile(keyPath, 'TLS private key');

  let certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error('TLS certificate is not a valid X.509 certificate');
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error('TLS private key is not a valid private key');
  }
  invariant(
    certificate.checkPrivateKey(privateKey),
    'TLS certificate does not match the private key',
  );

  const expiresAt = Date.parse(certificate.validTo);
  invariant(
    Number.isFinite(expiresAt) && expiresAt >= now + minimumValidityMs,
    'TLS certificate is expired or expires too soon',
  );
  invariant(
    certificate.checkHost(publicOrigin.hostname, { subject: 'never' }) !== undefined,
    'TLS certificate SAN does not match MITZO_PUBLIC_ORIGIN hostname',
  );
  return { certPath, keyPath, certificate };
}

/**
 * Validate the non-secret release identity carried by the lock.  This is kept
 * separate from the OpenShell feature switch: an operator must never be able
 * to start a production HTTP transport with an incomplete or mixed release
 * merely by turning OpenShell off.
 */
export function validateReleaseIdentity(manifest) {
  const release = manifest.release;
  invariant(release && typeof release === 'object', 'stack lock release identity is required');
  invariant(isCommit(release.mitzoSourceCommit), 'stack lock Mitzo source commit is invalid');
  const cli = release.openshellCli;
  invariant(cli && typeof cli === 'object', 'stack lock OpenShell CLI identity is required');
  invariant(
    typeof cli.identity === 'string' && cli.identity.length > 0,
    'stack lock OpenShell CLI identity is invalid',
  );
  invariant(isAbsolute(cli.path), 'stack lock OpenShell CLI path must be absolute');
  invariant(
    typeof cli.version === 'string' && cli.version.length > 0,
    'stack lock OpenShell CLI version is invalid',
  );
  invariant(isCommit(cli.sourceCommit), 'stack lock OpenShell CLI source commit is invalid');
  invariant(
    typeof release.gatewayService === 'string' && release.gatewayService.length > 0,
    'stack lock gateway service is required',
  );
  const supervisor = release.podmanSupervisor;
  invariant(
    supervisor && typeof supervisor === 'object',
    'stack lock Podman supervisor is required',
  );
  invariant(
    typeof supervisor.launchdLabel === 'string' && supervisor.launchdLabel.length > 0,
    'stack lock Podman supervisor launchd label is required',
  );
  invariant(
    typeof supervisor.artifactPath === 'string' && supervisor.artifactPath.length > 0,
    'stack lock Podman supervisor artifact path is required',
  );
  invariant(isSha256(supervisor.artifactSha256), 'stack lock Podman supervisor digest is invalid');
  const rollbackInputs = release.rollbackInputs;
  invariant(
    rollbackInputs && typeof rollbackInputs === 'object',
    'stack lock rollback inputs are required',
  );
  const accounts = rollbackInputs.accountProfiles;
  invariant(
    accounts &&
      typeof accounts.bundleId === 'string' &&
      accounts.bundleId.length > 0 &&
      accounts.reference === 'MITZO_ACCOUNT_PROFILES_FILE' &&
      isSha256(accounts.sha256),
    'stack lock account profile rollback reference is invalid',
  );
  const policy = rollbackInputs.policy;
  invariant(
    policy &&
      typeof policy.reference === 'string' &&
      policy.reference.length > 0 &&
      isSha256(policy.sha256) &&
      policy.sha256 === manifest.policy?.sha256,
    'stack lock policy rollback reference is invalid',
  );
  const seed = rollbackInputs.seed;
  invariant(
    seed &&
      typeof seed.bundleId === 'string' &&
      seed.bundleId.length > 0 &&
      typeof seed.baselineReference === 'string' &&
      seed.baselineReference.length > 0 &&
      isCommit(seed.startingCommit) &&
      seed.startingCommit === manifest.runtime?.mgmtSourceCommit,
    'stack lock seed rollback reference is invalid',
  );
  return { release, cli, supervisor };
}

/**
 * A release lock cannot name the commit that contains it: doing so would make
 * its own object ID self-referential.  The deployment checkout may therefore
 * be a one-commit metadata wrapper around the locked source commit.  Its
 * parent must be the lock's exact source commit, and it may change only the
 * lock and rollback record needed to describe that release.
 */
export function verifyCleanTrackedWorktree({ runCommand = run, root = repoRoot } = {}) {
  // Do not use `git diff HEAD`: that misses staged additions in an unborn or
  // otherwise unusual index, and does not describe unresolved paths as
  // clearly. Porcelain status covers staged, unstaged, and unmerged tracked
  // paths. Excluding untracked files deliberately permits local build output,
  // certificates, and other operator state that is not part of the source
  // release.
  const trackedStatus = runCommand('git', [
    '-C',
    root,
    'status',
    '--porcelain=v1',
    '--untracked-files=no',
  ]);
  invariant(
    trackedStatus.trim() === '',
    'Mitzo checkout has tracked changes; commit or discard them before production deploy',
  );
}

export function verifyCheckoutReleaseProvenance(
  release,
  { runCommand = run, root = repoRoot } = {},
) {
  verifyCleanTrackedWorktree({ runCommand, root });
  const checkoutCommit = runCommand('git', ['-C', root, 'rev-parse', 'HEAD']);
  if (checkoutCommit === release.mitzoSourceCommit) return checkoutCommit;

  const parentCommit = runCommand('git', ['-C', root, 'rev-parse', `${checkoutCommit}^`]);
  invariant(
    parentCommit === release.mitzoSourceCommit,
    'Mitzo checkout commit does not match the stack lock or its metadata wrapper',
  );
  const changedPaths = runCommand('git', [
    '-C',
    root,
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    checkoutCommit,
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  invariant(
    changedPaths.length > 0 && changedPaths.every((path) => RELEASE_METADATA_PATHS.has(path)),
    'Mitzo metadata wrapper contains non-release-metadata changes',
  );
  return checkoutCommit;
}

/**
 * Check locally observable release identity.  `runCommand` is injectable so
 * tests can prove mismatch behavior without calling a real gateway, launchd,
 * Podman, or Git checkout outside the fixture.
 */
export function verifyLocalReleaseIdentity(
  config,
  manifest,
  { runCommand = run, root = repoRoot } = {},
) {
  const { release, cli, supervisor } = validateReleaseIdentity(manifest);
  invariant(
    required(config, 'MITZO_OPENSHELL_CLI') === cli.path,
    'OpenShell CLI path does not match the stack lock',
  );
  invariant(
    required(config, 'MITZO_OPENSHELL_GATEWAY_SERVICE') === release.gatewayService,
    'OpenShell gateway service does not match the stack lock',
  );
  const checkoutCommit = verifyCheckoutReleaseProvenance(release, { runCommand, root });
  const cliVersion = runCommand(cli.path, ['--version']);
  invariant(
    cliVersion.toLowerCase().includes(cli.identity.toLowerCase()) &&
      cliVersion.split(/\s+/).includes(cli.version),
    'OpenShell CLI identity or version does not match the stack lock',
  );
  const artifactPath = resolve(root, supervisor.artifactPath);
  invariant(existsSync(artifactPath), 'Podman supervisor artifact does not exist');
  invariant(
    sha256(artifactPath) === supervisor.artifactSha256,
    'Podman supervisor artifact digest does not match the stack lock',
  );
  return { checkoutCommit, cliVersion, artifactPath };
}

/**
 * Account profiles remain outside the checkout because they name local
 * credential bindings. Their release digest is nevertheless non-secret and
 * must be pinned with the rest of the rollback inputs: accepting a replacement
 * file here would silently change the release's billing and sandbox bindings.
 */
export function verifyAccountProfileIntegrity(config, manifest) {
  const accounts = manifest.release?.rollbackInputs?.accountProfiles;
  invariant(
    accounts?.reference === 'MITZO_ACCOUNT_PROFILES_FILE' && isSha256(accounts.sha256),
    'stack lock account profile rollback reference is invalid',
  );
  const accountsPath = absoluteExisting(config, accounts.reference, 'file');
  invariant(
    sha256(accountsPath) === accounts.sha256,
    'account profiles hash does not match the stack lock',
  );
  return accountsPath;
}

export function validateRollbackRecord(manifest, rollback, stackLockSha256) {
  const { release, cli, supervisor } = validateReleaseIdentity(manifest);
  invariant(rollback?.schemaVersion === 1, 'unsupported rollback record schema');
  const rollbackRelease = rollback.release;
  invariant(rollbackRelease && typeof rollbackRelease === 'object', 'rollback release is required');
  invariant(
    rollbackRelease.stackLockSha256 === stackLockSha256,
    'rollback record stack lock digest does not match',
  );
  invariant(
    rollbackRelease.mitzoSourceCommit === release.mitzoSourceCommit,
    'rollback Mitzo commit does not match the stack lock',
  );
  invariant(
    JSON.stringify(rollbackRelease.openshellCli) === JSON.stringify(cli),
    'rollback OpenShell CLI identity does not match the stack lock',
  );
  invariant(
    rollbackRelease.gatewayService === release.gatewayService,
    'rollback gateway service does not match the stack lock',
  );
  invariant(
    JSON.stringify(rollbackRelease.podmanSupervisor) === JSON.stringify(supervisor),
    'rollback Podman supervisor does not match the stack lock',
  );
  invariant(
    JSON.stringify(rollbackRelease.runtime) === JSON.stringify(manifest.runtime),
    'rollback runtime does not match the stack lock',
  );
  invariant(
    JSON.stringify(rollbackRelease.rollbackInputs) === JSON.stringify(release.rollbackInputs),
    'rollback account, policy, or seed references do not match the stack lock',
  );
}

export function validateReleaseTransport(config, manifest) {
  const transport = manifest.release?.transport;
  invariant(transport && typeof transport === 'object', 'stack lock release transport is required');
  invariant(transport.tlsRequired === true, 'stack lock release transport must require TLS');
  const publicOrigin = required(config, 'MITZO_PUBLIC_ORIGIN');
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicOrigin);
  } catch {
    throw new Error('MITZO_PUBLIC_ORIGIN must be an HTTPS public origin');
  }
  invariant(
    parsedOrigin.protocol === 'https:' && !parsedOrigin.username && !parsedOrigin.password,
    'MITZO_PUBLIC_ORIGIN must be an HTTPS public origin',
  );
  invariant(
    parsedOrigin.pathname === '/' && !parsedOrigin.search && !parsedOrigin.hash,
    'MITZO_PUBLIC_ORIGIN must not include a path, query, or fragment',
  );
  invariant(
    originPort(parsedOrigin) === runtimePort(config),
    'MITZO_PUBLIC_ORIGIN port does not match PORT',
  );
  invariant(publicOrigin === transport.publicOrigin, 'public origin does not match the stack lock');
  invariant(
    transport.webSocketOrigin === publicOrigin.replace(/^https:/, 'wss:'),
    'stack lock WebSocket origin must be the WSS form of the public origin',
  );
  invariant(config.MITZO_REQUIRE_TLS === '1', 'MITZO_REQUIRE_TLS=1 is required by the stack lock');
  return transport;
}

function browserBuildFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? browserBuildFiles(child) : [child];
  });
}

export function verifyBakedBrowserOrigin(origin, buildDir = resolve(repoRoot, 'frontend', 'dist')) {
  invariant(existsSync(buildDir), 'frontend production build does not exist');
  // Source maps, HTML, and arbitrary copied assets can contain an origin without
  // configuring the browser runtime.  The executable Vite JavaScript chunks
  // are where VITE_API_BASE_URL is actually baked.
  const found = browserBuildFiles(buildDir).some(
    (path) =>
      statSync(path).isFile() &&
      path.endsWith('.js') &&
      readFileSync(path, 'utf8').includes(origin),
  );
  invariant(found, 'frontend production build does not contain the locked HTTPS public origin');
}

export function validateStaticConfig(config, manifest) {
  if (config.MITZO_OPENSHELL_ENABLED !== '1') return { enabled: false };
  invariant(
    !config.MITZO_OPENSHELL_PROVIDERS,
    'use MITZO_OPENSHELL_SERVICE_PROVIDERS, not MITZO_OPENSHELL_PROVIDERS',
  );
  const image = required(config, 'MITZO_OPENSHELL_IMAGE');
  const imageName = image.slice(image.lastIndexOf('/') + 1);
  invariant(imageName.includes(':'), 'MITZO_OPENSHELL_IMAGE must have an explicit tag');
  invariant(
    !/:(?:latest|dev)$/.test(image),
    'MITZO_OPENSHELL_IMAGE must use an immutable release tag',
  );
  invariant(image === manifest.runtime.image, 'runtime image does not match the stack lock');
  invariant(
    config.OPENSHELL_WORKSPACE === manifest.defaults.workspace,
    'OpenShell workspace does not match the stack lock',
  );
  invariant(
    config.MITZO_OPENSHELL_WEB_SEARCH === manifest.defaults.webSearch,
    'web-search mode does not match the stack lock',
  );
  const configuredProviders = splitProviders(required(config, 'MITZO_OPENSHELL_SERVICE_PROVIDERS'));
  const grantableProviders = splitProviders(
    required(config, 'MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS'),
  );
  invariant(
    JSON.stringify(configuredProviders) === JSON.stringify(manifest.providerPolicy.automatic),
    'automatic service providers do not match the ordered stack lock',
  );
  invariant(
    JSON.stringify(grantableProviders) === JSON.stringify(manifest.providerPolicy.grantable),
    'grantable service providers do not match the ordered stack lock',
  );
  invariant(
    !configuredProviders.some((provider) => grantableProviders.includes(provider)),
    'automatic and grantable service provider policies overlap',
  );
  const inventory = new Set(manifest.serviceProviders.map((provider) => provider.name));
  invariant(
    [...configuredProviders, ...grantableProviders].every((provider) => inventory.has(provider)),
    'provider policy references an unpinned service provider',
  );
  return { enabled: true, image, configuredProviders, grantableProviders };
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  }).trim();
}

export function verifyAccountBindings(accounts, providers) {
  invariant(Array.isArray(accounts), 'account profiles must be an array');
  const providerByName = new Map(providers.map((provider) => [provider.name, provider]));
  for (const account of accounts) {
    if (account.provider !== 'openai' && account.provider !== 'openai-codex') continue;
    invariant(account.sandboxProvider, `account ${account.id} is missing sandboxProvider`);
    const provider = providerByName.get(account.sandboxProvider);
    invariant(provider, `account ${account.id} references a missing sandbox provider`);
    if (account.provider === 'openai-codex') {
      invariant(
        account.sandboxProviderType === 'openai-codex-oauth',
        `account ${account.id} has the wrong broker type`,
      );
      invariant(
        account.sandboxProviderId && account.sandboxGrantId,
        `account ${account.id} has an incomplete broker binding`,
      );
      invariant(
        provider.id === account.sandboxProviderId,
        `account ${account.id} broker provider ID does not match the gateway`,
      );
      invariant(
        !account.credentialRef,
        `account ${account.id} mixes host and brokered credentials`,
      );
    }
  }
}

export function hasExactGlobalSetting(settings, key, value) {
  const escapeRegExp = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const settingPattern = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*${escapeRegExp(String(value))}\\s*(?:#.*)?$`,
    'm',
  );
  return settingPattern.test(settings);
}

export function main(
  argv = process.argv.slice(2),
  inheritedEnv = process.env,
  { buildDir, root = repoRoot, runCommand = run } = {},
) {
  const envPath = resolve(argv[0] ?? resolve(repoRoot, '.env'));
  const fileConfig = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const config = { ...fileConfig, ...inheritedEnv };
  const manifestPath = absoluteExisting(config, 'MITZO_OPENSHELL_STACK_MANIFEST', 'file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  invariant(manifest.schemaVersion === 1, 'unsupported OpenShell stack lock schema');
  const releaseTransport = validateReleaseTransport(config, manifest);
  verifyReleaseTls(config, { root });
  verifyBakedBrowserOrigin(releaseTransport.publicOrigin, buildDir);
  const rollbackPath = absoluteExisting(config, 'MITZO_OPENSHELL_ROLLBACK_RECORD', 'file');
  validateRollbackRecord(
    manifest,
    JSON.parse(readFileSync(rollbackPath, 'utf8')),
    sha256(manifestPath),
  );
  const accountsPath = verifyAccountProfileIntegrity(config, manifest);
  // This is deliberately before the feature switch. Disabling OpenShell only
  // skips live gateway/provider/image checks; it must not allow a mixed
  // checkout, account profile, CLI, gateway service setting, or supervisor
  // artifact to pass the production transport preflight.
  verifyLocalReleaseIdentity(config, manifest, { runCommand, root });
  if (config.MITZO_OPENSHELL_ENABLED !== '1') {
    console.log('OPENSHELL_PRODUCTION_PREFLIGHT=disabled');
    return;
  }

  const staticResult = validateStaticConfig(config, manifest);
  const policyPath = absoluteExisting(config, 'MITZO_OPENSHELL_POLICY', 'file');
  const seedPath = absoluteExisting(config, 'MITZO_OPENSHELL_SEED', 'directory');
  invariant(
    sha256(policyPath) === manifest.policy.sha256,
    'sandbox policy hash does not match the stack lock',
  );
  const seedBaselinePath = resolve(seedPath, '..', 'baseline.json');
  invariant(existsSync(seedBaselinePath), 'prepared seed baseline.json does not exist');
  const seedBaseline = JSON.parse(readFileSync(seedBaselinePath, 'utf8'));
  invariant(
    seedBaseline.startingCommit === manifest.runtime.mgmtSourceCommit,
    'prepared seed commit does not match the stack lock',
  );

  const openshell = required(config, 'MITZO_OPENSHELL_CLI');
  invariant(isAbsolute(openshell), 'MITZO_OPENSHELL_CLI must be absolute');
  const gatewayInfo = JSON.parse(runCommand(openshell, ['gateway', 'info', '-o', 'json']));
  invariant(
    gatewayInfo.version === manifest.gateway.version,
    'OpenShell gateway version does not match the stack lock',
  );
  const driver = gatewayInfo.compute_drivers?.find(
    (entry) => entry.name === manifest.gateway.driver,
  );
  invariant(
    driver?.capabilities?.driver_version === manifest.gateway.driverVersion,
    'OpenShell compute driver does not match the stack lock',
  );
  const settings = runCommand(openshell, ['settings', 'get', '--global']);
  for (const [key, value] of Object.entries(manifest.gateway.requiredGlobalSettings)) {
    invariant(
      hasExactGlobalSetting(settings, key, value),
      `required global setting ${key}=${value} is not active`,
    );
  }

  const providers = JSON.parse(runCommand(openshell, ['provider', 'list', '-o', 'json']));
  for (const expected of manifest.serviceProviders) {
    const actual = providers.find((provider) => provider.name === expected.name);
    invariant(
      actual?.type === expected.type,
      `service provider ${expected.name} has the wrong type or is missing`,
    );
    for (const key of expected.credentialKeys) {
      invariant(
        actual.credential_keys?.includes(key),
        `service provider ${expected.name} is missing credential key ${key}`,
      );
    }
  }
  verifyAccountBindings(JSON.parse(readFileSync(accountsPath, 'utf8')), providers);

  const podman = inheritedEnv.PODMAN ?? '/opt/homebrew/bin/podman';
  const imageDigest = runCommand(podman, [
    'image',
    'inspect',
    staticResult.image,
    '--format',
    '{{.Digest}}',
  ]);
  invariant(
    imageDigest === manifest.runtime.digest,
    'local runtime image digest does not match the stack lock',
  );
  const imageLabels = JSON.parse(
    runCommand(podman, ['image', 'inspect', staticResult.image, '--format', '{{json .Labels}}']),
  );
  invariant(
    imageLabels['io.mitzo.source-commit'] === manifest.runtime.mitzoSourceCommit,
    'runtime image Mitzo provenance does not match the stack lock',
  );
  invariant(
    imageLabels['io.mitzo.mgmt-source-commit'] === manifest.runtime.mgmtSourceCommit,
    'runtime image MGMT provenance does not match the stack lock',
  );
  invariant(
    imageLabels['io.mitzo.openshell.base-image'] === manifest.runtime.baseImage,
    'runtime image base provenance does not match the stack lock',
  );
  for (const binary of manifest.runtime.requiredBinaries ?? []) {
    runCommand(podman, [
      'run',
      '--rm',
      '--entrypoint',
      '/usr/bin/test',
      staticResult.image,
      '-x',
      binary,
    ]);
  }
  console.log(`OPENSHELL_PRODUCTION_GATEWAY=${gatewayInfo.version}`);
  console.log(
    `OPENSHELL_PRODUCTION_DRIVER=${manifest.gateway.driver}@${manifest.gateway.driverVersion}`,
  );
  console.log(`OPENSHELL_PRODUCTION_IMAGE=${manifest.runtime.image}`);
  console.log(`OPENSHELL_PRODUCTION_PROVIDERS=${staticResult.configuredProviders.join(',')}`);
  console.log(
    `OPENSHELL_PRODUCTION_GRANTABLE_PROVIDERS=${staticResult.grantableProviders.join(',')}`,
  );
  console.log('OPENSHELL_PRODUCTION_PREFLIGHT=pass');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `OPENSHELL_PRODUCTION_PREFLIGHT=fail: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
