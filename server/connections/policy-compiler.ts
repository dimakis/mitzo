import type { ProviderTemplate } from './types.js';

export interface CustomRestPolicyInput {
  endpoint: string;
  methods: readonly string[];
  paths: readonly string[];
  credentialStyle: 'bearer' | 'basic';
  binaries: readonly string[];
}

export interface CompiledConnectionPolicy {
  providerType: string;
  endpoint: { host: string; port: 443; protocol: 'rest'; enforcement: 'enforce'; tls: 'terminate' };
  rules: readonly { method: 'GET' | 'HEAD' | 'OPTIONS'; path: string }[];
  credential: { name: string; envVar: string; authStyle: 'bearer' | 'basic' };
  binaries: readonly string[];
}

export type PolicyCompiler = (
  template: ProviderTemplate,
  fields: Readonly<Record<string, unknown>>,
) => CompiledConnectionPolicy;

const ALLOWED_CUSTOM_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_CUSTOM_BINARIES = new Set([
  '/usr/bin/curl',
  '/usr/local/bin/curl',
  '/usr/bin/python3',
]);
const SAFE_PATH =
  /^\/[A-Za-z0-9._~!$&'()*+,;=:@-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*(?:\/\*\*)?$/;
const FORBIDDEN_HOSTS = new Set(['localhost', 'localhost.localdomain', 'local']);

function fail(message: string): never {
  throw new Error(`Invalid custom REST policy: ${message}`);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    return fail(`${field} must be a non-empty bounded list`);
  if (value.some((item) => typeof item !== 'string')) return fail(`${field} must contain strings`);
  const normalized = value.map((item) => item.trim());
  if (
    normalized.some((item) => item.length === 0) ||
    new Set(normalized).size !== normalized.length
  )
    return fail(`${field} must be unique non-empty strings`);
  return normalized;
}

function exactFieldKeys(fields: Readonly<Record<string, unknown>>, allowed: readonly string[]) {
  return Object.keys(fields).every((key) => allowed.includes(key));
}

function githubRepositoryList(value: unknown): string[] {
  const repositories = stringList(value, 'repositories');
  if (
    repositories.some(
      (repository) =>
        !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/.test(
          repository,
        ),
    )
  )
    fail('repositories must be canonical owner/name pairs');
  return repositories;
}

function githubBranchList(value: unknown): string[] {
  const branches = stringList(value, 'baseBranches');
  if (
    branches.some(
      (branch) =>
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch) ||
        branch.includes('..') ||
        branch.includes('//') ||
        branch.includes('@{') ||
        branch.endsWith('.') ||
        branch.endsWith('/'),
    )
  )
    fail('baseBranches must be canonical Git references');
  return branches;
}

/** Accept an HTTPS origin only; DNS resolution is deliberately delegated to the gateway. */
export function canonicalCustomRestEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253)
    return fail('endpoint must be a bounded URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail('endpoint must be a URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    return fail('endpoint must be a credential-free HTTPS origin on port 443');
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host.includes('*') ||
    FORBIDDEN_HOSTS.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  )
    return fail('endpoint host is not a public DNS hostname');
  return `https://${host}`;
}

/**
 * Compile the deliberately small custom REST schema. This is pure and never
 * accepts raw YAML, filesystem paths, commands, or a caller-selected compiler.
 */
export const compileCustomRestReadonly: PolicyCompiler = (template, fields) => {
  if (template.id !== 'custom-rest-readonly' || template.version !== 1)
    throw new Error('Custom REST compiler received an incompatible template');
  const allowedKeys = new Set(['endpoint', 'methods', 'paths', 'credentialStyle', 'binaries']);
  for (const key of Object.keys(fields)) if (!allowedKeys.has(key)) fail(`unknown field ${key}`);
  const canonicalEndpoint = canonicalCustomRestEndpoint(fields.endpoint);
  const host = new URL(canonicalEndpoint).hostname;
  const methods = stringList(fields.methods, 'methods');
  if (methods.some((method) => !ALLOWED_CUSTOM_METHODS.has(method)))
    fail('methods must be read-only HTTP methods');
  const paths = stringList(fields.paths, 'paths');
  if (paths.some((path) => !SAFE_PATH.test(path) || path.includes('//') || path.includes('..')))
    fail('paths must be canonical absolute API paths');
  const credentialStyle = fields.credentialStyle;
  if (credentialStyle !== 'bearer' && credentialStyle !== 'basic')
    fail('credentialStyle is not reviewed');
  const binaries = stringList(fields.binaries, 'binaries');
  if (binaries.some((binary) => !ALLOWED_CUSTOM_BINARIES.has(binary)))
    fail('binaries must come from the approved catalog');

  return {
    providerType: template.id,
    endpoint: { host, port: 443, protocol: 'rest', enforcement: 'enforce', tls: 'terminate' },
    rules: methods.flatMap((method) =>
      paths.map((path) => ({ method: method as 'GET' | 'HEAD' | 'OPTIONS', path })),
    ),
    credential: { name: 'api_token', envVar: 'CUSTOM_API_TOKEN', authStyle: credentialStyle },
    binaries,
  };
};

function fixedReadonlyPolicy(
  template: ProviderTemplate,
  host: string,
  credential: CompiledConnectionPolicy['credential'],
  binaries: readonly string[],
): CompiledConnectionPolicy {
  if (Object.keys(template).length === 0) throw new Error('Invalid template');
  return {
    providerType: template.id,
    endpoint: { host, port: 443, protocol: 'rest', enforcement: 'enforce', tls: 'terminate' },
    rules: [],
    credential,
    binaries,
  };
}

export const compileJiraReadonly: PolicyCompiler = (template, fields) => {
  if (
    template.id !== 'jira-readonly' ||
    template.version !== 1 ||
    !exactFieldKeys(fields, ['email']) ||
    typeof fields.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email) ||
    fields.email.length > 320
  )
    throw new Error('Invalid Jira policy input');
  return fixedReadonlyPolicy(
    template,
    'api.atlassian.com',
    { name: 'api_token', envVar: 'JIRA_API_TOKEN', authStyle: 'basic' },
    ['/usr/bin/python3', '/usr/bin/curl', '/usr/local/bin/curl'],
  );
};

export const compileGithubReadonly: PolicyCompiler = (template, fields) => {
  if (
    template.id !== 'github-readonly' ||
    template.version !== 1 ||
    !exactFieldKeys(fields, ['repositories', 'baseBranches'])
  )
    throw new Error('Invalid GitHub policy input');
  try {
    githubRepositoryList(fields.repositories);
    githubBranchList(fields.baseBranches);
  } catch {
    throw new Error('Invalid GitHub policy input');
  }
  return fixedReadonlyPolicy(
    template,
    'api.github.com',
    { name: 'token', envVar: 'GITHUB_TOKEN', authStyle: 'bearer' },
    ['/usr/bin/curl'],
  );
};
