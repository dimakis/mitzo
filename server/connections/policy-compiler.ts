import { isIP } from 'node:net';
import type { PolicyCompiler, ProviderPolicy, ProviderTemplate } from './types.js';

const readOnlyMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const safePath =
  /^\/(?:[A-Za-z0-9._~:@!$&'()*+,;=-]+|\*\*)?(?:\/(?:[A-Za-z0-9._~:@!$&'()*+,;=-]+|\*\*)?)*$/;

function policy(
  template: ProviderTemplate,
  endpoint: ProviderPolicy['endpoint'],
  rules: ProviderPolicy['rules'],
  allowedBinaries: readonly string[] = [],
): ProviderPolicy {
  return {
    templateId: template.id,
    templateVersion: template.version,
    endpoint,
    rules,
    credentialFieldKeys: template.credentialFields.map((field) => field.key),
    allowedBinaries,
  };
}

function fieldsMustBeEmpty(fields: Readonly<Record<string, string | string[]>>) {
  if (Object.keys(fields).length !== 0)
    throw new Error('This reviewed template has no public fields');
}

export const compileJiraReadonly: PolicyCompiler = (template, fields) => {
  fieldsMustBeEmpty(fields);
  const base = '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api';
  return policy(
    template,
    { host: 'api.atlassian.com', port: 443, protocol: 'rest', tls: 'terminate', redirects: 'deny' },
    [
      { method: 'GET', path: `${base}/2/**` },
      { method: 'HEAD', path: `${base}/2/**` },
      { method: 'GET', path: `${base}/3/**` },
      { method: 'HEAD', path: `${base}/3/**` },
    ],
    ['/usr/bin/python3', '/usr/bin/curl', '/usr/local/bin/curl'],
  );
};

export const compileGithubReadonly: PolicyCompiler = (template, fields) => {
  fieldsMustBeEmpty(fields);
  return policy(
    template,
    { host: 'github.com', port: 443, protocol: 'git', tls: 'terminate', redirects: 'deny' },
    [{ method: 'GIT_UPLOAD_PACK', path: '/**' }],
    ['/usr/bin/git'],
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
    host.includes('*') ||
    isIP(host) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  )
    throw new Error('Custom endpoint host is not allowed');
  return host;
}

export const compileCustomRestReadonly: PolicyCompiler = (template, fields) => {
  const allowed = new Set(['endpoint', 'methods', 'paths']);
  if (Object.keys(fields).some((key) => !allowed.has(key)))
    throw new Error('Unknown custom REST field');
  const endpoint = fields.endpoint;
  const methods = fields.methods;
  const paths = fields.paths;
  if (
    typeof endpoint !== 'string' ||
    !Array.isArray(methods) ||
    !Array.isArray(paths) ||
    methods.length === 0 ||
    paths.length === 0 ||
    methods.some((method) => !readOnlyMethods.has(method)) ||
    paths.some((path) => !safePath.test(path))
  )
    throw new Error('Custom REST fields are invalid');
  const host = customEndpoint(endpoint);
  return policy(
    template,
    { host, port: 443, protocol: 'rest', tls: 'terminate', redirects: 'deny' },
    methods.flatMap((method) =>
      paths.map((path) => ({ method: method as 'GET' | 'HEAD' | 'OPTIONS', path })),
    ),
    ['/usr/bin/curl', '/usr/local/bin/curl'],
  );
};
