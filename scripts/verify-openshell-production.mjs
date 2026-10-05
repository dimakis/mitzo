#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { userInfo } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { parse } from 'dotenv';
import { load } from 'js-yaml';

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

export function loadProductionConfig(envPath, inheritedEnv = process.env) {
  const fileConfig = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  return { ...inheritedEnv, ...fileConfig };
}

function verifyOpenAiEndpoints(endpoints) {
  const matching = endpoints.filter((endpoint) => endpoint.host === 'api.openai.com');
  invariant(matching.length > 0, 'OpenAI inspected endpoint is missing');
  for (const endpoint of matching) {
    invariant(
      endpoint.protocol === 'rest' && endpoint.enforcement === 'enforce' && endpoint.port === 443,
      'OpenAI endpoint must enforce inspected REST on port 443',
    );
    // These protobuf bools default to false and are omitted by the gateway's
    // JSON export when disabled. Only an explicit opt-in is unsafe here.
    invariant(
      endpoint.request_body_credential_rewrite !== true &&
        endpoint.allow_uninspected_credentials !== true,
      'OpenAI endpoint must use header authentication without body credential rewriting or inspection bypass',
    );
  }
}

export function verifyOpenAiHeaderAuthentication(profile) {
  invariant(
    profile.credentials?.some(
      (credential) =>
        credential.env_vars?.includes('OPENAI_API_KEY') &&
        credential.auth_style === 'bearer' &&
        credential.header_name?.toLowerCase() === 'authorization' &&
        !credential.query_param,
    ),
    'OpenAI provider must authenticate with the Authorization bearer header',
  );
  verifyOpenAiEndpoints(profile.endpoints ?? []);
}

function portableKnowledgePath(path) {
  if (
    /^\.git\/(?:HEAD|config|description|index|COMMIT_EDITMSG|logs\/HEAD|(?:refs|logs\/refs)\/heads\/[A-Za-z0-9_-]+|objects\/[a-f0-9]{2}\/[a-f0-9]{38})$/.test(
      path,
    )
  )
    return true;
  if (path.split('/').some((part) => part.startsWith('.'))) return false;
  if (/^(?:AGENTS|CLAUDE|CONSTITUTION|KNOWLEDGE|SERVICES|README)\.md$/.test(path)) return true;
  if (/^memory\/manifest\/(?:index|wikilinks|by_type|by_tag)\.json$/.test(path)) return true;
  if (/^memory\/(?!scripts\/|manifest\/).+\.md$/.test(path)) return true;
  return /^(?:jira_process|slack_observe|architecture|professional(?:\/(?:blog|linkedin))?|patents|music|health|command_center|knowledge_space|okrs\/shared_eng_excellence)\/(?:(?:AGENTS|CLAUDE|CONSTITUTION)\.md|context\/.+\.md)$/.test(
    path,
  );
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
    invariant(
      portableKnowledgePath(path),
      `prepared seed path is outside the portable knowledge allowlist: ${path}`,
    );
    invariant(
      (Number.parseInt(entry.mode, 8) & 0o7000) === 0,
      `prepared seed contains special file mode bits: ${path}`,
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

  if (actual.has('.git/config')) {
    const config = execFileSync(
      'git',
      ['config', '--file', resolve(root, '.git/config'), '--no-includes', '--list', '--null'],
      { encoding: 'utf8' },
    );
    const permitted = {
      'core.repositoryformatversion': ['0'],
      'core.filemode': ['true', 'false'],
      'core.bare': ['false'],
      'core.logallrefupdates': ['true'],
      'core.ignorecase': ['true', 'false'],
      'core.precomposeunicode': ['true', 'false'],
      'user.name': ['Mitzo Sandbox'],
      'user.email': ['sandbox@mitzo.invalid'],
    };
    for (const setting of config.split('\0').filter(Boolean)) {
      const separator = setting.indexOf('\n');
      invariant(
        separator > 0 &&
          permitted[setting.slice(0, separator)]?.includes(setting.slice(separator + 1)),
        'prepared seed portable Git config contains host or runtime settings',
      );
    }
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

// Keep these semantics identical to target_environment in the trusted builder
// helper. Parity tests exercise both implementations; runtime admission parses
// only data and never executes Python or code supplied by a publication.
export function validateRuntimeMarkerEnvironment(encoded, targetPlatform) {
  let environment;
  try {
    invariant(typeof encoded === 'string', 'marker environment must be base64');
    const bytes = Buffer.from(encoded, 'base64');
    invariant(bytes.toString('base64') === encoded, 'marker environment base64 is not canonical');
    environment = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new Error(
      'stack lock target marker environment must be canonical base64 containing valid UTF-8 JSON; regenerate it from the pinned runtime image',
    );
  }
  const keys = [
    'implementation_name',
    'implementation_version',
    'os_name',
    'platform_machine',
    'platform_release',
    'platform_system',
    'platform_version',
    'platform_python_implementation',
    'python_full_version',
    'python_version',
    'sys_platform',
  ];
  invariant(
    environment &&
      typeof environment === 'object' &&
      !Array.isArray(environment) &&
      Object.keys(environment).length === keys.length &&
      keys.every((key) => Object.hasOwn(environment, key) && typeof environment[key] === 'string'),
    'stack lock target marker environment requires exactly the complete string-valued marker keys; regenerate it from the pinned runtime image',
  );
  invariant(
    typeof targetPlatform === 'string' && /^[a-z0-9]+\/[a-z0-9][a-z0-9._-]*$/.test(targetPlatform),
    'stack lock target marker environment requires an explicit target platform',
  );
  const [operatingSystem, architecture] = targetPlatform.split('/');
  const system =
    new Map([
      ['linux', 'Linux'],
      ['darwin', 'Darwin'],
      ['win32', 'Windows'],
    ]).get(operatingSystem) ?? operatingSystem;
  const machine =
    new Map([
      ['amd64', 'x86_64'],
      ['arm64', 'aarch64'],
    ]).get(architecture) ?? architecture;
  invariant(
    environment.sys_platform === operatingSystem &&
      environment.os_name === (operatingSystem === 'win32' ? 'nt' : 'posix') &&
      environment.platform_system === system &&
      environment.platform_machine === machine,
    'stack lock target marker environment does not match the target platform; regenerate it from the pinned runtime image',
  );
  const version =
    /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:(?:a|b|rc)[0-9]+)?(?:\.post[0-9]+)?(?:\.dev[0-9]+)?$/;
  const pythonVersion = version.exec(environment.python_full_version);
  invariant(
    pythonVersion &&
      environment.python_version === `${pythonVersion[1]}.${pythonVersion[2]}` &&
      version.test(environment.implementation_version),
    'stack lock target marker environment contains invalid or incoherent Python versions; regenerate it from the pinned runtime image',
  );
  const implementation = new Map([
    ['cpython', 'CPython'],
    ['pypy', 'PyPy'],
    ['jython', 'Jython'],
    ['ironpython', 'IronPython'],
  ]).get(environment.implementation_name);
  invariant(
    /^[a-z][a-z0-9_]*$/.test(environment.implementation_name) &&
      environment.platform_python_implementation.length > 0 &&
      (!implementation || implementation === environment.platform_python_implementation) &&
      (environment.implementation_name !== 'cpython' ||
        environment.implementation_version === environment.python_full_version),
    'stack lock target marker environment contains an incoherent Python implementation; regenerate it from the pinned runtime image',
  );
  return environment;
}

export function validateSeedBaseline(seedBaseline, manifest, seedPath) {
  invariant(
    seedBaseline && typeof seedBaseline === 'object' && !Array.isArray(seedBaseline),
    'prepared seed baseline must be an object',
  );
  // The trusted runtime selection owns the publication lane. Removing fields
  // from the first dynamic bundle must never downgrade it to static admission.
  const dynamicFields = [
    'knowledgeSchemaVersion',
    'knowledgeCompilerSha256',
    'knowledgeRecipeSha256',
    'dependencyProjectionSha256',
    'targetMarkerEnvironmentB64',
    'targetPlatform',
    'jiraRuntimeInputsSha256',
  ];
  const selectedDynamicContract = dynamicFields.some((field) =>
    Object.hasOwn(manifest.runtime ?? {}, field),
  );
  invariant(
    !selectedDynamicContract || Object.hasOwn(seedBaseline, 'runtimeBaseCommit'),
    'selected knowledge runtime contract requires a dynamic publication baseline and publisher record; regenerate the publication with the pinned builder',
  );
  // Legacy static releases retain their exact-commit admission and historical
  // mismatch diagnostic before the stronger dynamic provenance validation.
  if (!Object.hasOwn(seedBaseline, 'runtimeBaseCommit')) {
    invariant(
      seedBaseline.startingCommit === manifest.runtime?.mgmtSourceCommit,
      'prepared seed commit does not match the stack lock',
    );
  }
  invariant(
    typeof seedBaseline.startingCommit === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(seedBaseline.startingCommit),
    'prepared seed source commit is invalid',
  );
  if (Object.hasOwn(seedBaseline, 'runtimeBaseCommit')) {
    invariant(seedPath !== undefined, 'dynamic knowledge requires content verification');
    invariant(
      seedBaseline.knowledgeSchemaVersion === 1 && manifest.runtime?.knowledgeSchemaVersion === 1,
      'unsupported knowledge schema; release a compatible runtime contract',
    );
    for (const field of ['knowledgeCompilerSha256', 'knowledgeRecipeSha256']) {
      invariant(
        typeof seedBaseline[field] === 'string' &&
          /^[a-f0-9]{64}$/.test(seedBaseline[field]) &&
          seedBaseline[field] === manifest.runtime?.[field],
        `knowledge compatibility failed: ${field}; release a compatible runtime contract`,
      );
    }
  }
  if (
    Object.hasOwn(seedBaseline, 'runtimeBaseCommit') &&
    (Object.hasOwn(seedBaseline, 'runtimeJiraInputsSha256') ||
      manifest.runtime?.jiraRuntimeInputsSha256 !== undefined)
  ) {
    invariant(
      typeof seedBaseline.runtimeJiraInputsSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(seedBaseline.runtimeJiraInputsSha256) &&
        seedBaseline.runtimeJiraInputsSha256 === manifest.runtime?.jiraRuntimeInputsSha256,
      'Jira runtime input compatibility failed; release a compatible runtime contract',
    );
  }
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
    validateRuntimeMarkerEnvironment(
      manifest.runtime?.targetMarkerEnvironmentB64,
      manifest.runtime?.targetPlatform,
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
    hasRuntimeBase
      ? 'prepared seed runtime base does not match the stack lock'
      : 'prepared seed commit does not match the stack lock',
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
    const payload = canonicalJsonPayload({
      startingCommit: seedBaseline.startingCommit,
      runtimeBaseCommit: seedBaseline.runtimeBaseCommit,
      runtimeDependencyProjectionSha256: seedBaseline.runtimeDependencyProjectionSha256,
      knowledgeSchemaVersion: seedBaseline.knowledgeSchemaVersion,
      knowledgeCompilerSha256: seedBaseline.knowledgeCompilerSha256,
      knowledgeRecipeSha256: seedBaseline.knowledgeRecipeSha256,
      ...(Object.hasOwn(seedBaseline, 'runtimeJiraInputsSha256')
        ? { runtimeJiraInputsSha256: seedBaseline.runtimeJiraInputsSha256 }
        : {}),
      files: seedBaseline.files,
    });
    invariant(
      createHash('sha256').update(payload).digest('hex') === seedBaseline.payloadSha256,
      'prepared dynamic seed payload digest does not match its file manifest',
    );
  }
}

function validateKnowledgePublication(seedBaseline, manifest, seedBaselinePath) {
  const publicationPath = resolve(seedBaselinePath, '..', 'publication.json');
  invariant(
    existsSync(publicationPath) && lstatSync(publicationPath).isFile(),
    'trusted knowledge publication record is missing or unsafe',
  );
  const publication = JSON.parse(readFileSync(publicationPath, 'utf8'));
  invariant(publication.schemaVersion === 1, 'unsupported knowledge publication schema');
  invariant(
    typeof publication.builderCommit === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(publication.builderCommit),
    'knowledge publication builder commit is invalid',
  );
  invariant(
    publication.baselineSha256 === sha256(seedBaselinePath),
    'knowledge publication baseline digest mismatch',
  );
  for (const [field, expected] of Object.entries({
    sourceCommit: seedBaseline.startingCommit,
    payloadSha256: seedBaseline.payloadSha256,
    runtimeImage: manifest.runtime.image,
    runtimeDigest: manifest.runtime.digest,
    runtimeBaseCommit: seedBaseline.runtimeBaseCommit,
    runtimeDependencyProjectionSha256: seedBaseline.runtimeDependencyProjectionSha256,
    knowledgeSchemaVersion: seedBaseline.knowledgeSchemaVersion,
    knowledgeCompilerSha256: seedBaseline.knowledgeCompilerSha256,
    knowledgeRecipeSha256: seedBaseline.knowledgeRecipeSha256,
    runtimeJiraInputsSha256: seedBaseline.runtimeJiraInputsSha256,
  }))
    invariant(publication[field] === expected, `knowledge publication ${field} mismatch`);
  invariant(
    typeof publication.runtimeImage === 'string' &&
      publication.runtimeImage.length > 0 &&
      typeof publication.runtimeDigest === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(publication.runtimeDigest),
    'knowledge publication immutable runtime identity is invalid',
  );
  invariant(
    publication.validation?.pinnedBuilder === true &&
      publication.validation?.runtimeContract === true &&
      publication.validation?.manifestProvenance === true,
    'knowledge publication validation evidence is missing',
  );
}

export function verifyPreparedSeed(seedPath, expectedCommit) {
  const seedBaselinePath = resolve(seedPath, '..', 'baseline.json');
  invariant(
    existsSync(seedBaselinePath) && lstatSync(seedBaselinePath).isFile(),
    'prepared seed baseline.json is missing or unsafe',
  );
  const seedBaseline = JSON.parse(readFileSync(seedBaselinePath, 'utf8'));
  if (typeof expectedCommit === 'object') {
    validateSeedBaseline(seedBaseline, expectedCommit, seedPath);
    if (Object.hasOwn(seedBaseline, 'runtimeBaseCommit'))
      validateKnowledgePublication(seedBaseline, expectedCommit, seedBaselinePath);
  } else {
    invariant(
      !Object.hasOwn(seedBaseline, 'runtimeBaseCommit'),
      'dynamic knowledge requires a complete stack lock',
    );
    invariant(
      seedBaseline.startingCommit === expectedCommit,
      'prepared seed commit does not match the stack lock',
    );
  }
}

/** Reproduce dotenv's fill-missing semantics for launchd; never log environment values. */
export function loadServiceGitEnvironment(plistPath, inheritedEnv = process.env, releaseEnv = {}) {
  try {
    const raw = execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `
import json,plistlib,sys
with open(sys.argv[1], 'rb') as f: p=plistlib.load(f)
env=p.get('EnvironmentVariables', {})
if not isinstance(env, dict) or any(not isinstance(k,str) or not isinstance(v,str) or chr(0) in v for k,v in env.items()): raise ValueError()
if not env.get('PATH'): raise ValueError()
sys.stdout.write(json.dumps(env))
`,
        plistPath,
      ],
      { env: inheritedEnv, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const account = userInfo();
    return {
      HOME: account.homedir,
      USER: account.username,
      LOGNAME: account.username,
      ...releaseEnv,
      ...JSON.parse(raw),
    };
  } catch {
    throw new Error('Candidate service Git environment is unavailable.');
  }
}

/** Validate the host Git used by the pinned knowledge adapter, without fetching or leaking stderr. */
export function verifyKnowledgeGit(config, executionEnv = config) {
  if (!config.MITZO_KNOWLEDGE_STORE_CONFIG) return;
  const env = Object.fromEntries(
    Object.entries(executionEnv).filter(([key]) => !key.startsWith('GIT_')),
  );
  try {
    const options = { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] };
    invariant(
      execFileSync('git', ['--version'], options).startsWith('git version '),
      'Invalid Git',
    );
    const execPath = execFileSync('git', ['--exec-path'], options).trim();
    invariant(isAbsolute(execPath), 'Invalid Git helper directory');
    accessSync(join(execPath, 'git-remote-https'), constants.X_OK);
  } catch {
    throw new Error(
      'Knowledge publication requires working Git with HTTPS support in the service PATH. Repair Git before deployment.',
    );
  }
}

export function main(argv = process.argv.slice(2), inheritedEnv = process.env) {
  const envPath = resolve(argv[0] ?? resolve(repoRoot, '.env'));
  // Candidate launchd settings and dotenv's fill-missing semantics define what
  // will actually run. Operator shell overrides must not validate another service.
  const releaseConfig = loadProductionConfig(envPath, inheritedEnv);
  invariant(
    argv.length <= 1 || (argv.length === 3 && argv[1] === '--service-plist'),
    'Unsupported production preflight arguments',
  );
  const hasServicePlist = argv[1] === '--service-plist';
  const serviceEnv = hasServicePlist
    ? loadServiceGitEnvironment(
        resolve(argv[2]),
        inheritedEnv,
        existsSync(envPath) ? parse(readFileSync(envPath)) : {},
      )
    : { ...releaseConfig, ...inheritedEnv };
  const config = hasServicePlist ? serviceEnv : releaseConfig;
  if (config.MITZO_OPENSHELL_ENABLED !== '1') {
    console.log('OPENSHELL_PRODUCTION_PREFLIGHT=disabled');
    return;
  }
  verifyKnowledgeGit(serviceEnv);
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
  verifyPreparedSeed(seedPath, manifest);

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
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf8'));
  verifyAccountBindings(accounts, providers);
  const apiProfiles = new Set(
    accounts
      .filter((account) => account.provider === 'openai')
      .map(
        (account) => providers.find((provider) => provider.name === account.sandboxProvider).type,
      ),
  );
  if (apiProfiles.size > 0) {
    const policy = load(readFileSync(policyPath, 'utf8'));
    verifyOpenAiEndpoints(
      Object.values(policy.network_policies ?? {}).flatMap((rule) => rule.endpoints ?? []),
    );
    for (const profileType of apiProfiles) {
      const profile = JSON.parse(
        run(openshell, ['provider', 'profile', 'export', profileType, '-o', 'json']),
      );
      verifyOpenAiHeaderAuthentication(profile);
    }
  }

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
  invariant(
    manifest.supervisor.image.includes(manifest.supervisor.sourceCommit.slice(0, 7)),
    'supervisor image tag does not identify the pinned source commit',
  );
  const supervisorDigest = run(podman, [
    'image',
    'inspect',
    manifest.supervisor.image,
    '--format',
    '{{.Digest}}',
  ]);
  invariant(
    supervisorDigest === manifest.supervisor.digest,
    'local supervisor image digest does not match the stack lock',
  );
  const supervisorSourceCommit = run(podman, [
    'image',
    'inspect',
    manifest.supervisor.image,
    '--format',
    '{{ index .Labels "org.opencontainers.image.revision" }}',
  ]);
  invariant(
    supervisorSourceCommit === manifest.supervisor.sourceCommit,
    'local supervisor image source revision does not match the stack lock',
  );
  const liveSupervisorDigest = run(podman, [
    'image',
    'inspect',
    'localhost/openshell/supervisor:dev',
    '--format',
    '{{.Digest}}',
  ]);
  invariant(
    liveSupervisorDigest === manifest.supervisor.digest,
    'Podman driver supervisor alias does not match the stack lock',
  );
  for (const binary of manifest.runtime.requiredBinaries ?? []) {
    run(podman, ['run', '--rm', '--entrypoint', '/usr/bin/test', staticResult.image, '-x', binary]);
  }
  console.log(`OPENSHELL_PRODUCTION_GATEWAY=${gatewayInfo.version}`);
  console.log(
    `OPENSHELL_PRODUCTION_DRIVER=${manifest.gateway.driver}@${manifest.gateway.driverVersion}`,
  );
  console.log(`OPENSHELL_PRODUCTION_IMAGE=${manifest.runtime.image}`);
  console.log(`OPENSHELL_PRODUCTION_SUPERVISOR=${manifest.supervisor.image}`);
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
