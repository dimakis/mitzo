#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
  invariant(
    JSON.stringify(configuredProviders) ===
      JSON.stringify(manifest.serviceProviders.map((provider) => provider.name)),
    'service providers do not match the ordered stack lock',
  );
  return { enabled: true, image, configuredProviders };
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
  invariant(
    seedBaseline.startingCommit === manifest.runtime.mgmtSourceCommit,
    'prepared seed commit does not match the stack lock',
  );

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
      settings.includes(`${key} = ${value}`),
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
    run(podman, ['run', '--rm', '--entrypoint', '/usr/bin/test', staticResult.image, '-x', binary]);
  }
  console.log(`OPENSHELL_PRODUCTION_GATEWAY=${gatewayInfo.version}`);
  console.log(
    `OPENSHELL_PRODUCTION_DRIVER=${manifest.gateway.driver}@${manifest.gateway.driverVersion}`,
  );
  console.log(`OPENSHELL_PRODUCTION_IMAGE=${manifest.runtime.image}`);
  console.log(`OPENSHELL_PRODUCTION_PROVIDERS=${staticResult.configuredProviders.join(',')}`);
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
