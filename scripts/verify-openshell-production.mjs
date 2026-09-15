#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')))
        .map((key) => [key, canonicalJson(value[key])]),
    );
  return value;
}

export function canonicalJsonPayload(value) {
  return JSON.stringify(canonicalJson(value));
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

function validateSeedContents(seedBaseline, seedPath) {
  invariant(typeof seedPath === 'string' && isAbsolute(seedPath), 'prepared seed path is invalid');
  invariant(
    seedBaseline.files &&
      typeof seedBaseline.files === 'object' &&
      !Array.isArray(seedBaseline.files),
    'prepared dynamic seed file manifest is invalid',
  );
  const root = resolve(seedPath);
  const expected = new Map();
  for (const [path, entry] of Object.entries(seedBaseline.files)) {
    invariant(
      typeof path === 'string' &&
        path.length > 0 &&
        !path.startsWith('/') &&
        !path.split('/').includes('..') &&
        resolve(root, path).startsWith(`${root}${sep}`),
      'prepared seed file manifest contains an unsafe path',
    );
    invariant(
      entry &&
        typeof entry === 'object' &&
        typeof entry.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.sha256) &&
        typeof entry.mode === 'string' &&
        /^[0-7]{4}$/.test(entry.mode),
      `prepared seed file manifest has an invalid hash or mode for ${path}`,
    );
    expected.set(path, entry);
  }

  const actual = new Map();
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      const stat = lstatSync(absolutePath);
      invariant(!stat.isSymbolicLink(), `prepared seed contains an unsafe symlink: ${path}`);
      if (stat.isDirectory()) walk(absolutePath, path);
      else if (stat.isFile()) {
        actual.set(path, {
          sha256: sha256(absolutePath),
          mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
        });
      } else invariant(false, `prepared seed contains an unsupported path: ${path}`);
    }
  };
  walk(root);
  invariant(
    actual.size === expected.size &&
      [...actual.keys()].every((path) => expected.has(path)) &&
      [...expected.keys()].every((path) => actual.has(path)),
    'prepared seed files do not exactly match baseline.json',
  );
  for (const [path, entry] of expected) {
    invariant(
      actual.get(path).sha256 === entry.sha256 && actual.get(path).mode === entry.mode,
      `prepared seed file hash or mode does not match baseline.json: ${path}`,
    );
  }

  for (const name of ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json']) {
    const manifestPath = resolve(root, 'memory', 'manifest', name);
    invariant(
      relative(root, manifestPath) && !relative(root, manifestPath).startsWith(`..${sep}`),
      'prepared seed manifest path is invalid',
    );
    let generated;
    try {
      generated = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`prepared seed manifest is missing or invalid: ${name}: ${error.message}`);
    }
    invariant(
      generated && generated.sourceCommit === seedBaseline.startingCommit,
      `prepared seed manifest source commit does not match baseline: ${name}`,
    );
  }
}

export function validateSeedBaseline(seedBaseline, manifest, seedPath) {
  invariant(
    seedBaseline && typeof seedBaseline === 'object' && !Array.isArray(seedBaseline),
    'prepared seed baseline must be an object',
  );
  invariant(
    typeof seedBaseline.startingCommit === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(seedBaseline.startingCommit),
    'prepared seed source commit is invalid',
  );
  const hasRuntimeBase = Object.hasOwn(seedBaseline, 'runtimeBaseCommit');
  if (hasRuntimeBase) {
    invariant(
      typeof seedBaseline.runtimeBaseCommit === 'string' &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(seedBaseline.runtimeBaseCommit),
      'prepared seed runtime base commit is invalid',
    );
  }
  if (hasRuntimeBase && seedPath !== undefined) {
    invariant(
      typeof seedBaseline.runtimeDependencyProjectionSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(seedBaseline.runtimeDependencyProjectionSha256),
      'prepared dynamic seed runtime dependency projection is invalid or missing',
    );
    invariant(
      typeof manifest.runtime?.dependencyProjectionSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(manifest.runtime.dependencyProjectionSha256),
      'stack lock runtime dependency projection is invalid or missing',
    );
    invariant(
      typeof manifest.runtime?.targetMarkerEnvironmentB64 === 'string' &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(manifest.runtime.targetMarkerEnvironmentB64),
      'stack lock target marker environment is invalid or missing',
    );
    invariant(
      seedBaseline.runtimeDependencyProjectionSha256 ===
        manifest.runtime.dependencyProjectionSha256,
      'prepared seed runtime dependency projection does not match the stack lock',
    );
  }
  invariant(
    hasRuntimeBase
      ? seedBaseline.runtimeBaseCommit === manifest.runtime.mgmtSourceCommit
      : seedBaseline.startingCommit === manifest.runtime.mgmtSourceCommit,
    'prepared seed runtime base does not match the stack lock',
  );
  // Legacy baselines predate the dynamic seed contract and retain only the
  // historical exact-commit comparison above. Every baseline with an explicit
  // runtime base is dynamically generated and must bind to its selected seed.
  if (hasRuntimeBase && seedPath !== undefined) {
    validateSeedContents(seedBaseline, seedPath);
    invariant(
      typeof seedBaseline.payloadSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(seedBaseline.payloadSha256),
      'prepared dynamic seed payload digest is invalid or missing',
    );
    invariant(
      typeof manifest.runtime?.seedPayloadSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(manifest.runtime.seedPayloadSha256),
      'stack lock dynamic seed payload digest is invalid or missing',
    );
    const payload = canonicalJsonPayload({
      startingCommit: seedBaseline.startingCommit,
      runtimeBaseCommit: seedBaseline.runtimeBaseCommit,
      runtimeDependencyProjectionSha256: seedBaseline.runtimeDependencyProjectionSha256,
      files: seedBaseline.files,
    });
    invariant(
      createHash('sha256').update(payload).digest('hex') === seedBaseline.payloadSha256,
      'prepared dynamic seed payload digest does not match its file manifest',
    );
    invariant(
      seedBaseline.payloadSha256 === manifest.runtime.seedPayloadSha256,
      'prepared dynamic seed payload digest does not match the stack lock',
    );
  }
}

export function validateRuntimeDependencyProjection(projection, manifest) {
  invariant(
    typeof manifest.runtime?.dependencyProjectionSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.runtime.dependencyProjectionSha256),
    'stack lock runtime dependency projection is invalid or missing',
  );
  const canonical = `${String(projection).trim()}\n`;
  invariant(
    createHash('sha256').update(canonical).digest('hex') ===
      manifest.runtime.dependencyProjectionSha256,
    'runtime image dependency projection does not match the stack lock',
  );
}

export function validateRuntimeResolutionContract(contract, manifest, imageLabels) {
  invariant(
    typeof manifest.runtime?.dependencyProjectionSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(manifest.runtime.dependencyProjectionSha256),
    'stack lock runtime dependency projection is invalid or missing',
  );
  invariant(
    typeof contract === 'string' && contract.endsWith('\n'),
    'runtime resolution contract is invalid',
  );
  let parsed;
  try {
    parsed = JSON.parse(contract);
  } catch (error) {
    throw new Error(`runtime resolution contract is invalid: ${error.message}`);
  }
  invariant(parsed?.schemaVersion === 1, 'runtime resolution contract has an unsupported schema');
  const digest = createHash('sha256').update(contract).digest('hex');
  invariant(
    digest === manifest.runtime.dependencyProjectionSha256,
    'runtime image resolution contract does not match the stack lock',
  );
  invariant(
    imageLabels?.['io.mitzo.runtime-resolution-contract-sha256'] === digest,
    'runtime image resolution contract label does not match its embedded contract',
  );
  invariant(
    parsed.target?.baseImage === manifest.runtime.baseImage,
    'runtime resolution contract base image does not match the stack lock',
  );
  invariant(
    parsed.target?.platform === imageLabels?.['io.mitzo.runtime-target-platform'],
    'runtime resolution contract platform does not match the runtime image',
  );
}

export function validateRuntimeImageLabels(imageLabels, manifest) {
  invariant(
    imageLabels?.['io.mitzo.source-commit'] === manifest.runtime.mitzoSourceCommit,
    'runtime image Mitzo provenance does not match the stack lock',
  );
  invariant(
    imageLabels?.['io.mitzo.mgmt-source-commit'] === manifest.runtime.mgmtSourceCommit,
    'runtime image MGMT provenance does not match the stack lock',
  );
  invariant(
    imageLabels?.['io.mitzo.openshell.base-image'] === manifest.runtime.baseImage,
    'runtime image base provenance does not match the stack lock',
  );
}

export function main(argv = process.argv.slice(2), inheritedEnv = process.env) {
  const envPath = resolve(argv[0] ?? resolve(repoRoot, '.env'));
  const fileConfig = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const config = { ...fileConfig, ...inheritedEnv };
  if (config.MITZO_OPENSHELL_ENABLED !== '1') {
    console.log('OPENSHELL_PRODUCTION_PREFLIGHT=disabled');
    return;
  }

  const manifestPath = absoluteExisting(config, 'MITZO_OPENSHELL_STACK_MANIFEST', 'file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  invariant(manifest.schemaVersion === 1, 'unsupported OpenShell stack lock schema');
  const staticResult = validateStaticConfig(config, manifest);
  const policyPath = absoluteExisting(config, 'MITZO_OPENSHELL_POLICY', 'file');
  const seedPath = absoluteExisting(config, 'MITZO_OPENSHELL_SEED', 'directory');
  const accountsPath = absoluteExisting(config, 'MITZO_ACCOUNT_PROFILES_FILE', 'file');
  invariant(
    sha256(policyPath) === manifest.policy.sha256,
    'sandbox policy hash does not match the stack lock',
  );
  const seedBaselinePath = resolve(seedPath, '..', 'baseline.json');
  invariant(existsSync(seedBaselinePath), 'prepared seed baseline.json does not exist');
  const seedBaseline = JSON.parse(readFileSync(seedBaselinePath, 'utf8'));
  validateSeedBaseline(seedBaseline, manifest, seedPath);

  const openshell = required(config, 'MITZO_OPENSHELL_CLI');
  invariant(isAbsolute(openshell), 'MITZO_OPENSHELL_CLI must be absolute');
  const gatewayInfo = JSON.parse(run(openshell, ['gateway', 'info', '-o', 'json']));
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
  const settings = run(openshell, ['settings', 'get', '--global']);
  for (const [key, value] of Object.entries(manifest.gateway.requiredGlobalSettings)) {
    invariant(
      hasExactGlobalSetting(settings, key, value),
      `required global setting ${key}=${value} is not active`,
    );
  }

  const providers = JSON.parse(run(openshell, ['provider', 'list', '-o', 'json']));
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
  const imageDigest = run(podman, [
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
    run(podman, ['image', 'inspect', staticResult.image, '--format', '{{json .Labels}}']),
  );
  validateRuntimeImageLabels(imageLabels, manifest);
  if (Object.hasOwn(seedBaseline, 'runtimeBaseCommit')) {
    const runtimeContract = run(podman, [
      'run',
      '--rm',
      '--entrypoint',
      '/usr/bin/cat',
      staticResult.image,
      '/opt/mgmt-resolution-contract.json',
    ]);
    validateRuntimeResolutionContract(`${runtimeContract}\n`, manifest, imageLabels);
  }
  for (const binary of manifest.runtime.requiredBinaries ?? []) {
    run(podman, ['run', '--rm', '--entrypoint', '/usr/bin/test', staticResult.image, '-x', binary]);
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
