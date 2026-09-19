import { isIP } from 'node:net';
import { parse as parseDomain } from 'tldts';
import { z } from 'zod';
import { canonicalPublicDnsAddress } from './iana-address-policy.js';
import type {
  PinnedPublicDnsAnswers,
  PolicyCompiler,
  ProviderPolicy,
  ProviderTemplate,
  PublicOnlyPinnedDnsRequirement,
} from './types.js';

const readOnlyMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const maxCustomMethods = 3;
const maxCustomPaths = 20;
const maxCustomPathLength = 256;
const maxCustomRules = 24;
const maxGithubScopeEntries = 50;
const customPathLiteralSegment = /^[A-Za-z0-9._~:@!$&'()+,;=-]+$/;
// Keep the compiler in lockstep with the schema validator used for connection
// fields. A permissive local/domain regexp admits invalid DNS labels and dots.
const Email = z.string().email();
// GitHub account names are 1–39 ASCII alphanumerics/hyphens and may not
// begin or end with a hyphen. Repository names have a distinct contract:
// `.github` is valid, so do not reuse the owner validator for them.
const githubOwner = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const githubRepositoryName = /^[a-z0-9._-]{1,100}$/;
const githubBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const githubObjectId = /^[0-9a-f]{40}$/i;
// Git and GitHub branch names are case-sensitive. Only exact uppercase HEAD
// is ambiguous when the executor resolves origin/HEAD (the remote default).
// Other Git pseudorefs are unqualified names and are not aliases for an
// `origin/<branch>` remote-tracking ref, so rejecting them would overblock
// ordinary exact GitHub branch names.
const ambiguousGithubBaseBranches = new Set(['HEAD']);

function policy(
  template: ProviderTemplate,
  endpoints: ProviderPolicy['endpoints'],
  publicConfig: ProviderPolicy['publicConfig'],
): ProviderPolicy {
  return deepFreeze({
    templateId: template.id,
    templateVersion: template.version,
    endpoints,
    credentialFieldKeys: template.credentialFields.map((field) => field.key),
    publicConfig,
  });
}
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function requireOnlyFields(
  fields: Readonly<Record<string, string | string[]>>,
  required: readonly string[],
) {
  const keys = Object.keys(fields);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(fields, key)))
    throw new Error('Template public fields are invalid');
}
function requiredString(
  fields: Readonly<Record<string, string | string[]>>,
  key: string,
  maxLength: number,
) {
  const value = fields[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  )
    throw new Error(`Invalid ${key}`);
  return value;
}
function orderedUnique<T>(values: readonly T[]) {
  return [...new Set(values)];
}
function requiredStringList(
  fields: Readonly<Record<string, string | string[]>>,
  key: string,
  maxInput: number,
) {
  const value = fields[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxInput)
    throw new Error(`Invalid ${key}`);
  if (value.some((item) => typeof item !== 'string')) throw new Error(`Invalid ${key}`);
  return value as readonly string[];
}

export const compileJiraReadonly: PolicyCompiler = (template, fields) => {
  requireOnlyFields(fields, ['email']);
  const submittedEmail = requiredString(fields, 'email', 320);
  if (!Email.safeParse(submittedEmail).success) throw new Error('Invalid email');
  const base = '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api';
  return policy(
    template,
    [
      {
        host: 'api.atlassian.com',
        port: 443,
        protocol: 'rest',
        tls: 'terminate',
        redirects: 'deny',
        rules: [
          { method: 'GET', path: `${base}/2/**` },
          { method: 'HEAD', path: `${base}/2/**` },
          { method: 'GET', path: `${base}/3/**` },
          { method: 'HEAD', path: `${base}/3/**` },
        ],
        allowedBinaries: ['/usr/bin/python3', '/usr/bin/curl', '/usr/local/bin/curl'],
      },
    ],
    { email: submittedEmail },
  );
};

function canonicalGithubRepositories(values: readonly string[]) {
  const canonical = values.map((value) => value.toLowerCase());
  if (
    canonical.some((value) => {
      const [owner, repository, ...extra] = value.split('/');
      return (
        !owner ||
        !repository ||
        extra.length !== 0 ||
        !githubOwner.test(owner) ||
        !githubRepositoryName.test(repository) ||
        repository === '.' ||
        repository === '..'
      );
    })
  )
    throw new Error('Invalid allowedRepositories');
  return orderedUnique(canonical);
}
function canonicalGithubBranches(values: readonly string[]) {
  if (
    values.some(
      (value) =>
        !githubBranch.test(value) ||
        ambiguousGithubBaseBranches.has(value) ||
        value.startsWith('refs/') ||
        githubObjectId.test(value) ||
        value.includes('..') ||
        value.includes('//') ||
        value.endsWith('.') ||
        value.endsWith('/') ||
        value.includes('@{') ||
        value
          .split('/')
          .some(
            (component) =>
              component.length === 0 || component.startsWith('.') || component.endsWith('.lock'),
          ),
    )
  )
    throw new Error('Invalid allowedBaseBranches');
  return orderedUnique(values);
}

export const compileGithubReadonly: PolicyCompiler = (template, fields) => {
  requireOnlyFields(fields, ['allowedRepositories', 'allowedBaseBranches']);
  const allowedRepositories = canonicalGithubRepositories(
    requiredStringList(fields, 'allowedRepositories', maxGithubScopeEntries),
  );
  const allowedBaseBranches = canonicalGithubBranches(
    requiredStringList(fields, 'allowedBaseBranches', maxGithubScopeEntries),
  );
  return policy(
    template,
    [
      {
        host: 'api.github.com',
        port: 443,
        protocol: 'rest',
        tls: 'terminate',
        redirects: 'deny',
        rules: [
          { method: 'GET', path: '/**' },
          { method: 'HEAD', path: '/**' },
        ],
        allowedBinaries: ['/usr/bin/curl', '/usr/local/bin/curl'],
      },
      {
        host: 'api.github.com',
        port: 443,
        protocol: 'graphql',
        tls: 'terminate',
        redirects: 'deny',
        rules: [{ method: 'GRAPHQL_QUERY', path: '/graphql' }],
        allowedBinaries: ['/usr/bin/curl', '/usr/local/bin/curl'],
      },
      {
        host: 'github.com',
        port: 443,
        protocol: 'git',
        tls: 'terminate',
        redirects: 'deny',
        rules: [{ method: 'GIT_UPLOAD_PACK', path: '/**' }],
        allowedBinaries: ['/usr/bin/git'],
      },
    ],
    { allowedRepositories, allowedBaseBranches },
  );
};

function customEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Custom endpoint must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.port !== ''
  )
    throw new Error('Custom endpoint must be an HTTPS origin without credentials or a custom port');
  const host = url.hostname.toLowerCase();
  // Custom egress is restricted to ICANN registrable domains. Private suffixes
  // are intentionally not accepted: their ownership/routing policy is not a
  // stable public egress boundary for an operator-defined connection.
  const registrable = parseDomain(host, { allowPrivateDomains: true, detectSpecialUse: true });
  if (
    !host ||
    host.length > 253 ||
    Buffer.byteLength(host, 'utf8') > 253 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.includes('*') ||
    isIP(host) !== 0 ||
    !registrable.domain ||
    !registrable.isIcann ||
    registrable.isPrivate ||
    registrable.isSpecialUse === true ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  )
    throw new Error('Custom endpoint host is not allowed');
  return host;
}

function canonicalCustomPath(value: string) {
  if (value === '/') return value;
  if (
    value.length === 0 ||
    value.length > maxCustomPathLength ||
    !value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('//') ||
    value.endsWith('/')
  )
    throw new Error('Custom REST path is invalid');
  const segments = value.slice(1).split('/');
  if (
    segments.some(
      (segment, index) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        (segment === '**'
          ? index !== segments.length - 1
          : !customPathLiteralSegment.test(segment)),
    )
  )
    throw new Error('Custom REST path is invalid');
  return value;
}

export function customDnsRequirement(hostname: string): PublicOnlyPinnedDnsRequirement {
  return {
    mode: 'pinned-public-only',
    hostname,
    verifyAt: 'provision-and-every-use',
    rejectRebinding: true,
  };
}

/** Called by the future gateway adapter before provisioning, then compared before every use. */
export function pinPublicDnsAnswers(
  requirement: PublicOnlyPinnedDnsRequirement,
  answers: readonly string[],
): PinnedPublicDnsAnswers {
  if (
    answers.length === 0 ||
    answers.length > 16 ||
    answers.some((answer) => !canonicalPublicDnsAddress(answer))
  )
    throw new Error('Custom endpoint DNS answers must be public IP addresses');
  return Object.freeze({
    ...requirement,
    addresses: Object.freeze(
      orderedUnique(answers.map((answer) => canonicalPublicDnsAddress(answer)!)).sort(),
    ),
  });
}
/** Any DNS answer change, including a new public answer, is a fail-closed rebind. */
export function verifyPinnedPublicDns(pin: PinnedPublicDnsAnswers, answers: readonly string[]) {
  const current = pinPublicDnsAnswers(pin, answers).addresses;
  if (
    current.length !== pin.addresses.length ||
    current.some((address, index) => address !== pin.addresses[index])
  )
    throw new Error('Custom endpoint DNS rebinding detected');
}

export const compileCustomRestReadonly: PolicyCompiler = (template, fields) => {
  requireOnlyFields(fields, ['endpoint', 'methods', 'paths']);
  const endpoint = requiredString(fields, 'endpoint', 2048);
  const rawMethods = requiredStringList(fields, 'methods', maxCustomMethods);
  const rawPaths = requiredStringList(fields, 'paths', maxCustomPaths);
  const methods = orderedUnique(rawMethods);
  if (methods.some((method) => !readOnlyMethods.has(method)))
    throw new Error('Custom REST methods are invalid');
  const paths = orderedUnique(rawPaths.map(canonicalCustomPath));
  if (methods.length * paths.length > maxCustomRules)
    throw new Error('Custom REST rule set is too large');
  const host = customEndpoint(endpoint);
  return policy(
    template,
    [
      {
        host,
        port: 443,
        protocol: 'rest',
        tls: 'terminate',
        redirects: 'deny',
        dns: customDnsRequirement(host),
        rules: methods.flatMap((method) =>
          paths.map((path) => ({ method: method as 'GET' | 'HEAD' | 'OPTIONS', path })),
        ),
        allowedBinaries: ['/usr/bin/curl', '/usr/local/bin/curl'],
      },
    ],
    { endpoint: `https://${host}`, methods, paths },
  );
};
