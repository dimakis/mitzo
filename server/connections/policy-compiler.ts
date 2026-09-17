import { isIP } from 'node:net';
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
const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const githubRepository =
  /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const githubBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function policy(
  template: ProviderTemplate,
  endpoints: ProviderPolicy['endpoints'],
  publicConfig: ProviderPolicy['publicConfig'],
): ProviderPolicy {
  return {
    templateId: template.id,
    templateVersion: template.version,
    endpoints,
    credentialFieldKeys: template.credentialFields.map((field) => field.key),
    publicConfig,
  };
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
  if (!email.test(submittedEmail)) throw new Error('Invalid email');
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
  if (canonical.some((value) => !githubRepository.test(value)))
    throw new Error('Invalid allowedRepositories');
  return orderedUnique(canonical);
}
function canonicalGithubBranches(values: readonly string[]) {
  if (
    values.some(
      (value) =>
        !githubBranch.test(value) ||
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
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.includes('*') ||
    isIP(host) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  )
    throw new Error('Custom endpoint host is not allowed');
  return host;
}

function canonicalCustomPath(value: string) {
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
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        (segment !== '**' && !/^[A-Za-z0-9._~:@!$&'()*+,;=-]+$/.test(segment)),
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
function ipv6Words(address: string) {
  const lower = address.toLowerCase();
  const ipv4Suffix = lower.lastIndexOf(':');
  let normalized = lower;
  if (ipv4Suffix !== -1 && lower.slice(ipv4Suffix + 1).includes('.')) {
    const ipv4 = lower.slice(ipv4Suffix + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split('.').map(Number);
    normalized = `${lower.slice(0, ipv4Suffix)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const compressed = normalized.split('::');
  if (compressed.length > 2) return undefined;
  const words = (part: string) =>
    part ? part.split(':').map((word) => Number.parseInt(word, 16)) : [];
  const left = words(compressed[0]!);
  const right = words(compressed[1] ?? '');
  if (
    [...left, ...right].some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff) ||
    (!normalized.includes('::') && left.length !== 8) ||
    (normalized.includes('::') && left.length + right.length > 7)
  )
    return undefined;
  return normalized.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
}

/**
 * Canonicalize and allow only globally-routable addresses. DNS text can spell
 * one IPv6 address many ways, so range checks must use parsed words rather
 * than prefixes of its original representation.
 */
function canonicalPublicDnsAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 192 && b === 31 && octets[2] === 196) ||
      (a === 192 && b === 52 && octets[2] === 193) ||
      (a === 192 && b === 88 && octets[2] === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a >= 224
    )
      return undefined;
    return octets.join('.');
  }
  if (family === 6) {
    const words = ipv6Words(address);
    if (!words) return undefined;
    // Global unicast is 2000::/3. This rejects unspecified, loopback,
    // IPv4-compatible/mapped, ULA, link/site-local, and multicast ranges.
    if ((words[0]! & 0xe000) !== 0x2000) return undefined;
    // IANA special-purpose allocations within global-unicast space.
    if (
      (words[0] === 0x2001 && (words[1]! & 0xfe00) === 0x0000) || // 2001::/23
      (words[0] === 0x2001 && words[1] === 0x0db8) || // documentation
      words[0] === 0x2002 || // 6to4, including embedded private IPv4 forms
      (words[0] === 0x3fff && (words[1]! & 0xfff0) === 0) // documentation
    )
      return undefined;
    return words.map((word) => word.toString(16).padStart(4, '0')).join(':');
  }
  return undefined;
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
  return {
    ...requirement,
    addresses: Object.freeze(
      orderedUnique(answers.map((answer) => canonicalPublicDnsAddress(answer)!)).sort(),
    ),
  };
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
