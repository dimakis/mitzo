import { isIP } from 'node:net';
import { parse as parseDomain } from 'tldts';
import { z } from 'zod';
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
type IanaIpv6Allocation = readonly [firstWord: number, secondWord: number, prefixLength: number];

/**
 * IANA's IPv6 Global Unicast Address Space registry, reviewed 2026-09-17:
 * https://www.iana.org/assignments/ipv6-unicast-address-assignments/
 *
 * This is deliberately an allowlist, rather than accepting all of 2000::/3:
 * IANA reserves every prefix absent from that registry for future allocation.
 * Review the registry and update this list (with boundary tests) whenever this
 * policy is changed or released; a newly allocated range remains unavailable
 * until that review is complete.
 *
 * The IANA 2001::/23 and 2002::/16 rows are intentionally omitted. They carry
 * special-purpose/transition assignments, not a general public DNS allowance.
 */
const ianaAllocatedPublicIpv6Prefixes: readonly IanaIpv6Allocation[] = [
  [0x2001, 0x0200, 23],
  [0x2001, 0x0400, 23],
  [0x2001, 0x0600, 23],
  [0x2001, 0x0800, 22],
  [0x2001, 0x0c00, 23],
  [0x2001, 0x0e00, 23],
  [0x2001, 0x1200, 23],
  [0x2001, 0x1400, 22],
  [0x2001, 0x1800, 23],
  [0x2001, 0x1a00, 23],
  [0x2001, 0x1c00, 22],
  [0x2001, 0x2000, 19],
  [0x2001, 0x4000, 23],
  [0x2001, 0x4200, 23],
  [0x2001, 0x4400, 23],
  [0x2001, 0x4600, 23],
  [0x2001, 0x4800, 23],
  [0x2001, 0x4a00, 23],
  [0x2001, 0x4c00, 23],
  [0x2001, 0x5000, 20],
  [0x2001, 0x8000, 19],
  [0x2001, 0xa000, 20],
  [0x2001, 0xb000, 20],
  [0x2003, 0x0000, 18],
  [0x2400, 0x0000, 12],
  [0x2410, 0x0000, 12],
  [0x2600, 0x0000, 12],
  [0x2610, 0x0000, 23],
  [0x2620, 0x0000, 23],
  [0x2630, 0x0000, 12],
  [0x2800, 0x0000, 12],
  [0x2a00, 0x0000, 12],
  [0x2a10, 0x0000, 12],
  [0x2c00, 0x0000, 12],
];
// Keep the compiler in lockstep with the schema validator used for connection
// fields. A permissive local/domain regexp admits invalid DNS labels and dots.
const Email = z.string().email();
// GitHub account names are 1–39 ASCII alphanumerics/hyphens and may not
// begin or end with a hyphen. Repository names have a distinct contract:
// `.github` is valid, so do not reuse the owner validator for them.
const githubOwner = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const githubRepositoryName = /^[a-z0-9._-]{1,100}$/;
const githubBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
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

function hasIpv6Prefix(words: readonly number[], prefix: IanaIpv6Allocation) {
  const [firstWord, secondWord, prefixLength] = prefix;
  if (prefixLength <= 16) {
    const mask = (0xffff << (16 - prefixLength)) & 0xffff;
    return (words[0]! & mask) === firstWord;
  }
  const suffixLength = prefixLength - 16;
  const mask = (0xffff << (16 - suffixLength)) & 0xffff;
  return words[0] === firstWord && (words[1]! & mask) === secondWord;
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
      (a === 192 && b === 0 && octets[2] === 0) ||
      (a === 192 && b === 0 && octets[2] === 2) ||
      (a === 192 && b === 31 && octets[2] === 196) ||
      (a === 192 && b === 52 && octets[2] === 193) ||
      (a === 192 && b === 88 && octets[2] === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) ||
      a >= 224
    )
      return undefined;
    return octets.join('.');
  }
  if (family === 6) {
    const words = ipv6Words(address);
    if (!words) return undefined;
    // Do not treat all of 2000::/3 as public. The unlisted portions are
    // IANA-reserved future space, so only the reviewed allocation list passes.
    if (!ianaAllocatedPublicIpv6Prefixes.some((prefix) => hasIpv6Prefix(words, prefix)))
      return undefined;
    // IANA special-purpose allocations can live inside an allocated RIR block.
    if (words[0] === 0x2001 && words[1] === 0x0db8) return undefined; // documentation
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
