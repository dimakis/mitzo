import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { dump, load } from 'js-yaml';
import { z } from 'zod';
import { connectionTemplateRegistry } from './registry.js';
import type { ProviderPolicy } from './types.js';

const JiraProfile = z
  .object({
    id: z.literal('jira-readonly'),
    // Gateway import may advance the durable resource version; policy semantics do not change.
    resource_version: z.number().int().positive(),
    display_name: z.string().min(1),
    description: z.string().min(1),
    category: z.literal('data'),
    inference_capable: z.literal(false),
    credentials: z
      .array(
        z
          .object({
            name: z.literal('api_token'),
            description: z.string().min(1),
            env_vars: z.tuple([z.literal('JIRA_API_TOKEN')]),
            required: z.literal(true),
            auth_style: z.literal('basic'),
            header_name: z.literal('authorization'),
            // OpenShell serializes its default rather than skipping this field.
            query_param: z.literal('').optional(),
          })
          .strict(),
      )
      .length(1),
    endpoints: z
      .array(
        z
          .object({
            host: z.string(),
            port: z.number().int(),
            protocol: z.string(),
            enforcement: z.literal('enforce'),
            tls: z.literal('terminate'),
            request_body_credential_rewrite: z.literal(false).optional(),
            allow_uninspected_credentials: z.literal(false).optional(),
            rules: z.array(
              z
                .object({ allow: z.object({ method: z.string(), path: z.string() }).strict() })
                .strict(),
            ),
          })
          .strict(),
      )
      .length(1),
    binaries: z
      .array(z.enum(['/usr/bin/python3', '/usr/bin/curl', '/usr/local/bin/curl']))
      .length(3)
      .refine((value) => new Set(value).size === 3, 'Jira profile binaries must be unique'),
    // Gateway metadata is not policy input, but must remain a bounded scalar projection.
    source: z.string().max(256).optional(),
    scope: z.string().max(256).optional(),
  })
  .strict();
const customPathLiteralSegment = /^[A-Za-z0-9._~:@!$&'()+,;=-]+$/;
function isCanonicalCustomPath(path: string) {
  if (path === '/') return true;
  const segments = path.slice(1).split('/');
  return (
    path.startsWith('/') &&
    !path.endsWith('/') &&
    segments.every(
      (segment, index) =>
        (segment === '**' && index === segments.length - 1) ||
        (segment !== '**' && customPathLiteralSegment.test(segment)),
    )
  );
}
export function customEndpoint(policy: ProviderPolicy) {
  if (
    policy.templateId !== 'custom-rest-readonly' ||
    policy.templateVersion !== 1 ||
    policy.endpoints.length !== 1
  )
    throw new Error('Invalid custom REST policy');
  const endpoint = policy.endpoints[0]!;
  const host = endpoint.host.toLowerCase();
  if (
    !endpoint.dns ||
    endpoint.dns.mode !== 'pinned-public-only' ||
    endpoint.dns.hostname !== endpoint.host ||
    endpoint.dns.verifyAt !== 'provision-and-every-use' ||
    endpoint.dns.rejectRebinding !== true ||
    endpoint.host !== host ||
    host.endsWith('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.includes('*') ||
    isIP(host) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      host,
    ) ||
    endpoint.redirects !== 'deny' ||
    endpoint.tls !== 'terminate' ||
    ![443, 8443].includes(endpoint.port) ||
    !['rest', 'graphql'].includes(endpoint.protocol) ||
    !endpoint.allowedBinaries.includes('/usr/bin/curl') ||
    endpoint.allowedBinaries.some(
      (path) => !['/usr/bin/curl', '/usr/bin/jq', '/usr/bin/python3'].includes(path),
    ) ||
    endpoint.rules.length === 0 ||
    endpoint.rules.length > 24 ||
    endpoint.rules.some(
      (rule) =>
        !isCanonicalCustomPath(rule.path) ||
        (endpoint.protocol === 'rest' && !['GET', 'HEAD', 'OPTIONS'].includes(rule.method)) ||
        (endpoint.protocol === 'graphql' &&
          (rule.method !== 'GRAPHQL_QUERY' || rule.path !== '/graphql')),
    )
  )
    throw new Error('Invalid custom REST policy');
  return endpoint;
}

/** Stable, code-owned profile identifier. User input cannot name a profile. */
export function customRestProfileId(policy: ProviderPolicy) {
  const endpoint = customEndpoint(policy);
  const pinnedIps = policy.publicConfig.dnsPin;
  if (
    !Array.isArray(pinnedIps) ||
    pinnedIps.length === 0 ||
    pinnedIps.some((ip) => typeof ip !== 'string')
  )
    throw new Error('Custom endpoint DNS pin is unavailable');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        host: endpoint.host,
        port: endpoint.port,
        protocol: endpoint.protocol,
        allowedIps: pinnedIps,
        rules: endpoint.rules,
        binaries: endpoint.allowedBinaries,
        credentialStyle: policy.publicConfig.credentialStyle,
        credentialLocation: policy.publicConfig.credentialLocation,
        credentialName: policy.publicConfig.credentialName,
      }),
    )
    .digest('hex')
    .slice(0, 20);
  return `mitzo-custom-rest-${digest}`;
}

/** Generated only from a compiled policy; browser YAML is never parsed or imported. */
export function renderCustomRestProfile(policy: ProviderPolicy) {
  const endpoint = customEndpoint(policy);
  const pinnedIps = policy.publicConfig.dnsPin;
  if (
    !Array.isArray(pinnedIps) ||
    pinnedIps.length === 0 ||
    pinnedIps.some((ip) => typeof ip !== 'string')
  )
    throw new Error('Custom endpoint DNS pin is unavailable');
  const style = policy.publicConfig.credentialStyle;
  const location = policy.publicConfig.credentialLocation;
  const name = policy.publicConfig.credentialName;
  if (
    (style !== 'bearer-token' && style !== 'api-token') ||
    (location !== 'header' && location !== 'query') ||
    typeof name !== 'string' ||
    !['authorization', 'x-api-key', 'api_key', 'access_token'].includes(name) ||
    (style === 'bearer-token' && (location !== 'header' || name !== 'authorization')) ||
    (location === 'header' && name !== 'authorization' && name !== 'x-api-key') ||
    (location === 'query' && name !== 'api_key' && name !== 'access_token')
  )
    throw new Error('Invalid custom credential mapping');
  const profile = {
    id: customRestProfileId(policy),
    resource_version: 1,
    display_name: 'Mitzo custom REST read-only',
    description: 'Mitzo-generated bounded custom API policy',
    category: 'data',
    inference_capable: false,
    credentials: [
      {
        name: 'api_token',
        description: 'One-shot custom API token',
        env_vars: ['MITZO_CUSTOM_API_TOKEN'],
        required: true,
        auth_style: style === 'bearer-token' ? 'bearer' : 'api_key',
        ...(location === 'header' ? { header_name: name } : { query_param: name }),
      },
    ],
    endpoints: [
      {
        host: endpoint.host,
        port: endpoint.port,
        protocol: endpoint.protocol,
        // The egress proxy checks this exact allowlist at connect time, so a
        // resolver answer changing after controller verification cannot
        // redirect a credential-bearing request.
        allowed_ips: pinnedIps,
        enforcement: 'enforce',
        tls: 'terminate',
        rules: endpoint.rules.map((rule) => ({ allow: rule })),
      },
    ],
    binaries: endpoint.allowedBinaries,
  };
  return { id: profile.id, yaml: dump(profile, { noRefs: true, lineWidth: -1, sortKeys: false }) };
}

/** Existing deterministic IDs are not proof that gateway state still matches policy. */
export function validateCustomRestProfileYaml(value: string, policy: ProviderPolicy): void {
  try {
    const expected = load(renderCustomRestProfile(policy).yaml);
    const actual = load(value);
    if (!isDeepStrictEqual(actual, expected)) throw new Error('mismatch');
  } catch {
    throw new Error('Installed custom REST profile differs from compiled policy');
  }
}

/** The registry compiler is the policy authority; profile exports are observations only. */
export function supportsConnectionRuntimeTemplate(id: string, version: number): boolean {
  return (
    version === 1 &&
    ['jira-readonly', 'github-readonly', 'custom-rest-readonly'].includes(id) &&
    !!connectionTemplateRegistry.getProviderTemplate(id, version)
  );
}

export function validateJiraProfileYaml(value: string): void {
  try {
    reviewedConnectionRuntimeProfile('jira-readonly', load(value));
  } catch {
    throw new Error('Reviewed Jira profile differs from required policy');
  }
}

export function reviewedConnectionRuntimeProfile(
  type: string,
  profile: unknown,
  policy?: ProviderPolicy,
): unknown | undefined {
  if (type === 'github') return reviewedGithubRuntimeProfile();
  if (type === 'jira-readonly') {
    const parsed = JiraProfile.parse(profile);
    const compiled = connectionTemplateRegistry.compileProviderPolicy({
      templateId: 'jira-readonly',
      templateVersion: 1,
      fields: { email: 'synthetic@example.org' },
    });
    const endpoints = compiled.endpoints.map(({ host, port, protocol, tls, rules }) => ({
      host,
      port,
      protocol,
      enforcement: 'enforce',
      tls,
      rules: rules.map((allow) => ({ allow })),
    }));
    const binaries = [
      ...new Set(compiled.endpoints.flatMap((endpoint) => endpoint.allowedBinaries)),
    ];
    if (
      !isDeepStrictEqual(
        parsed.endpoints.map(
          ({
            request_body_credential_rewrite: _rewrite,
            allow_uninspected_credentials: _inspection,
            ...endpoint
          }) => endpoint,
        ),
        endpoints,
      ) ||
      !isDeepStrictEqual([...parsed.binaries].sort(), binaries.sort())
    )
      throw new Error('Reviewed Jira profile differs from compiled connection policy');
    return parsed;
  }
  if (type.startsWith('mitzo-custom-rest-')) {
    if (
      !policy ||
      policy.templateId !== 'custom-rest-readonly' ||
      !supportsConnectionRuntimeTemplate(policy.templateId, policy.templateVersion)
    )
      throw new Error('Reviewed custom connection policy is unavailable');
    const compiled = connectionTemplateRegistry.compileProviderPolicy({
      templateId: policy.templateId,
      templateVersion: policy.templateVersion,
      fields: Object.fromEntries(
        Object.entries(policy.publicConfig).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : [...value],
        ]),
      ),
    });
    if (!isDeepStrictEqual(compiled, policy))
      throw new Error('Reviewed custom connection policy differs from compiler');
    const rendered = renderCustomRestProfile(compiled);
    if (rendered.id !== type)
      throw new Error('Reviewed custom connection profile identity differs');
    return load(rendered.yaml);
  }
  return undefined;
}

/** Exact builtin adapter bytes are reviewed alongside the registry/compiler contract. */
export function reviewedGithubRuntimeProfile(): Record<string, unknown> {
  const path = new URL(
    '../../infra/openshell/providers/github-reviewed-profile.json',
    import.meta.url,
  );
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    realpathSync(path) !== path.pathname ||
    st.size > 65536
  )
    throw new Error('Reviewed GitHub runtime profile is not physical');
  const bytes = readFileSync(path);
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '596409689258f387f8fb819dc445ba45b9f0e1cff81c809f18594a45a027ea7a'
  )
    throw new Error('Reviewed GitHub runtime profile changed');
  return load(bytes.toString('utf8')) as Record<string, unknown>;
}

export function validateGithubRuntimeProfileYaml(value: string): void {
  try {
    const actual = load(value) as Record<string, unknown>;
    if (
      !actual ||
      typeof actual !== 'object' ||
      Array.isArray(actual) ||
      (actual.source !== undefined && actual.source !== 'builtin') ||
      actual.scope !== undefined ||
      actual.resource_version !== undefined
    )
      throw new Error('Invalid builtin provenance');
    delete actual.source;
    const normalize = (profile: Record<string, unknown>) => {
      const result = structuredClone(profile);
      for (const endpoint of result.endpoints as Record<string, unknown>[])
        for (const key of ['request_body_credential_rewrite', 'allow_uninspected_credentials'])
          if (endpoint[key] === false) delete endpoint[key];
      for (const credential of result.credentials as Record<string, unknown>[])
        if (credential.query_param === '') delete credential.query_param;
      return result;
    };
    if (!isDeepStrictEqual(normalize(actual), normalize(reviewedGithubRuntimeProfile())))
      throw new Error('Mismatch');
  } catch {
    throw new Error('Effective GitHub profile differs from reviewed runtime contract');
  }
}
