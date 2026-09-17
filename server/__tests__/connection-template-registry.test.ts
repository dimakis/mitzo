import { describe, expect, it } from 'vitest';
import {
  customDnsRequirement,
  pinPublicDnsAnswers,
  verifyPinnedPublicDns,
} from '../connections/policy-compiler.js';
import {
  ianaAddressDataIntegrity,
  ianaIpv4SpecialPurposeCidrs,
  ianaIpv6AllocatedGlobalUnicastCidrs,
  ianaIpv6SpecialPurposeCidrs,
} from '../connections/iana-address-data.generated.js';
import {
  canonicalPublicDnsAddress,
  cidrContains,
  parseCidr,
  parseIpAddress,
} from '../connections/iana-address-policy.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderIanaAddressData } from '../../scripts/generate-iana-address-data.mjs';
import { loadIanaAddressData } from '../../scripts/iana-address-data.mjs';
import {
  connectionTemplateRegistry,
  createConnectionTemplateRegistry,
  projectCapabilityTemplate,
  projectProviderTemplate,
  reviewedHandlerBindings,
  validateVersionedTemplateRelationships,
} from '../connections/registry.js';
import type { JsonSchema } from '../connections/types.js';

const jira = connectionTemplateRegistry.getProviderTemplate('jira-readonly', 1)!;
const github = connectionTemplateRegistry.getProviderTemplate('github-readonly', 1)!;
const githubPublish = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1)!;

describe('connection template registry', () => {
  it('contains reviewed versioned contracts with immutable Jira and GitHub connection scopes', () => {
    expect(connectionTemplateRegistry.providerTemplates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'jira-readonly', version: 1 }),
        expect.objectContaining({ id: 'github-readonly', version: 1 }),
        expect.objectContaining({ id: 'custom-rest-readonly', version: 1 }),
      ]),
    );
    expect(projectProviderTemplate(jira).connectionFields).toEqual([
      expect.objectContaining({ key: 'email', kind: 'email', required: true }),
    ]);
    expect(projectProviderTemplate(jira).credentialFields).toEqual([
      expect.objectContaining({ key: 'token', style: 'basic', required: true }),
    ]);
    expect(projectProviderTemplate(jira).guidance).toEqual({
      body: 'Use a scoped token with Jira read permission.',
      href: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
      linkLabel: 'Atlassian token and scope guidance',
    });
    expect(projectProviderTemplate(github).connectionFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'allowedRepositories', required: true }),
        expect.objectContaining({ key: 'allowedBaseBranches', required: true }),
      ]),
    );
    expect(projectProviderTemplate(github).capabilityTemplates).toEqual([
      { id: 'github.publish-pr', version: 1 },
    ]);
    expect(projectCapabilityTemplate(githubPublish).connectionTemplates).toEqual([
      { id: 'github-readonly', version: 1 },
    ]);
    expect(githubPublish.inputSchema.properties).toMatchObject({
      connectionId: { minLength: 1 },
      repositoryPath: { minLength: 1 },
      baseBranch: { minLength: 1 },
      title: { minLength: 1 },
    });
    expect(connectionTemplateRegistry.getProviderTemplate('github-readonly', 2)).toBeUndefined();
    expect(
      connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 2),
    ).toBeUndefined();
  });

  it('pins provider/capability compatibility to exact versions', () => {
    const githubV2 = { ...github, version: 2, capabilityTemplates: [] };
    expect(() =>
      validateVersionedTemplateRelationships([github, githubV2], [githubPublish]),
    ).not.toThrow();
    expect(() =>
      validateVersionedTemplateRelationships(
        [github],
        [
          githubPublish,
          {
            ...githubPublish,
            version: 2,
            connectionTemplates: [{ id: 'github-readonly', version: 1 }],
          },
        ],
      ),
    ).toThrow('bidirectional');
  });

  it('projects only public metadata, never secrets or code-owned execution identifiers', () => {
    const publicProvider = projectProviderTemplate(github);
    const wire = JSON.stringify({
      provider: publicProvider,
      capability: projectCapabilityTemplate(githubPublish),
    });
    for (const forbidden of [
      'policyCompiler',
      'probe',
      'executor',
      'inputSchema',
      'github-readonly-v1',
      'github-publish-pr-v1',
      'GITHUB_TOKEN',
      'SENTINEL_SECRET',
    ])
      expect(wire).not.toContain(forbidden);
    expect(publicProvider.credentialFields[0]).toEqual(
      expect.objectContaining({ key: 'token', secret: true }),
    );
    expect(projectProviderTemplate(jira).guidance).toEqual(
      expect.objectContaining({
        href: expect.stringMatching(/^https:\/\//),
        linkLabel: 'Atlassian token and scope guidance',
      }),
    );
  });

  it('compiles independently inspected endpoints and canonical immutable connection fields', () => {
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'jira-readonly',
        templateVersion: 1,
        fields: { email: 'person@example.com' },
      }),
    ).toMatchObject({ publicConfig: { email: 'person@example.com' } });
    expect(() =>
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'jira-readonly',
        templateVersion: 1,
        fields: {},
      }),
    ).toThrow('Template public fields are invalid');
    for (const invalid of ['.user@example.com', 'user@-example.com', 'user@example..com'])
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'jira-readonly',
          templateVersion: 1,
          fields: { email: invalid },
        }),
      ).toThrow('Invalid email');

    const githubPolicy = connectionTemplateRegistry.compileProviderPolicy({
      templateId: 'github-readonly',
      templateVersion: 1,
      fields: {
        allowedRepositories: ['Acme/Widget', 'acme/widget'],
        allowedBaseBranches: ['main', 'main'],
      },
    });
    expect(githubPolicy.publicConfig).toEqual({
      allowedRepositories: ['acme/widget'],
      allowedBaseBranches: ['main'],
    });
    expect(Object.isFrozen(githubPolicy)).toBe(true);
    expect(Object.isFrozen(githubPolicy.endpoints)).toBe(true);
    expect(Object.isFrozen(githubPolicy.endpoints[0]!)).toBe(true);
    expect(Object.isFrozen(githubPolicy.endpoints[0]!.rules)).toBe(true);
    expect(Object.isFrozen(githubPolicy.endpoints[0]!.rules[0]!)).toBe(true);
    expect(Object.isFrozen(githubPolicy.publicConfig)).toBe(true);
    expect(Object.isFrozen(githubPolicy.publicConfig.allowedRepositories)).toBe(true);
    expect(() => {
      (githubPolicy.endpoints as unknown as Array<{ host: string }>)[0]!.host = 'evil.test';
    }).toThrow();
    expect(() => {
      (githubPolicy.endpoints[0]!.rules as unknown as Array<{ path: string }>)[0]!.path =
        '/admin/**';
    }).toThrow();
    expect(() => {
      (githubPolicy.publicConfig.allowedRepositories as string[])[0] = 'evil/repo';
    }).toThrow();
    expect(githubPolicy.endpoints).toEqual([
      expect.objectContaining({ host: 'api.github.com', protocol: 'rest' }),
      expect.objectContaining({
        host: 'api.github.com',
        protocol: 'graphql',
        rules: [{ method: 'GRAPHQL_QUERY', path: '/graphql' }],
      }),
      expect.objectContaining({
        host: 'github.com',
        protocol: 'git',
        rules: [{ method: 'GIT_UPLOAD_PACK', path: '/**' }],
        allowedBinaries: ['/usr/bin/git'],
      }),
    ]);
    expect(() =>
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'github-readonly',
        templateVersion: 1,
        fields: { allowedRepositories: ['acme/*'], allowedBaseBranches: ['main'] },
      }),
    ).toThrow('Invalid allowedRepositories');
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'github-readonly',
        templateVersion: 1,
        fields: { allowedRepositories: ['valid-owner/.github'], allowedBaseBranches: ['main'] },
      }).publicConfig.allowedRepositories,
    ).toEqual(['valid-owner/.github']);
    for (const invalid of [
      'owner_name/repo',
      '-owner/repo',
      'owner-/repo',
      'owner/.',
      'owner/..',
      `${'a'.repeat(40)}/repo`,
    ])
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'github-readonly',
          templateVersion: 1,
          fields: { allowedRepositories: [invalid], allowedBaseBranches: ['main'] },
        }),
      ).toThrow('Invalid allowedRepositories');
  });

  it('bounds, deduplicates, and canonicalizes custom REST policies before expanding rules', () => {
    const policy = connectionTemplateRegistry.compileProviderPolicy({
      templateId: 'custom-rest-readonly',
      templateVersion: 1,
      fields: {
        endpoint: 'https://api.openai.com',
        methods: ['GET', 'GET', 'HEAD'],
        paths: ['/v1/items', '/v1/items'],
      },
    });
    expect(policy.endpoints).toMatchObject([
      {
        host: 'api.openai.com',
        dns: {
          mode: 'pinned-public-only',
          verifyAt: 'provision-and-every-use',
          rejectRebinding: true,
        },
        rules: [
          { method: 'GET', path: '/v1/items' },
          { method: 'HEAD', path: '/v1/items' },
        ],
      },
    ]);
    expect(policy.publicConfig).toEqual({
      endpoint: 'https://api.openai.com',
      methods: ['GET', 'HEAD'],
      paths: ['/v1/items'],
    });
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'custom-rest-readonly',
        templateVersion: 1,
        fields: {
          endpoint: 'https://api.openai.com',
          methods: ['GET'],
          paths: ['/', '/v1/**'],
        },
      }),
    ).toMatchObject({
      publicConfig: { paths: ['/', '/v1/**'] },
      endpoints: [
        {
          rules: [
            { method: 'GET', path: '/' },
            { method: 'GET', path: '/v1/**' },
          ],
        },
      ],
    });

    for (const fields of [
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/../admin'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1//admin'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/%2e%2e/admin'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1\\admin'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/*'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/foo*'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/***'] },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: ['/v1/**/items'] },
      {
        endpoint: 'https://api.openai.com',
        methods: ['GET', 'HEAD', 'OPTIONS', 'GET'],
        paths: ['/v1/items'],
      },
      { endpoint: 'https://api.openai.com', methods: ['GET'], paths: [`/${'a'.repeat(257)}`] },
      {
        endpoint: 'https://api.openai.com',
        methods: ['GET'],
        paths: Array.from({ length: 21 }, (_, index) => `/v1/${index}`),
      },
      {
        endpoint: 'https://api.openai.com',
        methods: ['GET', 'HEAD', 'OPTIONS'],
        paths: Array.from({ length: 20 }, (_, index) => `/v1/${index}`),
      },
    ])
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'custom-rest-readonly',
          templateVersion: 1,
          fields,
        }),
      ).toThrow();
  });

  it('rejects unsafe custom hosts, credentials, ports, wildcards, mutations, and secret fields', () => {
    const invalidFields: Array<Record<string, string | string[]>> = [
      { endpoint: 'http://api.example.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://127.0.0.1', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://[::1]', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://localhost', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://co.uk', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.invalid', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.test', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.corp', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://service.onion', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://host.home.arpa', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://foo.blogspot.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://service.local', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://service.internal', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://user:pass@api.example.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.example.com:8443', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://*.example.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.example.com', methods: ['POST'], paths: ['/v1/items'] },
      {
        endpoint: `https://${Array.from({ length: 4 }, () => 'a'.repeat(63)).join('.')}`,
        methods: ['GET'],
        paths: ['/v1/items'],
      },
      {
        endpoint: 'https://api.example.com',
        methods: ['GET'],
        paths: ['/v1/items'],
        token: 'SENTINEL_SECRET',
      },
    ];
    for (const fields of invalidFields)
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'custom-rest-readonly',
          templateVersion: 1,
          fields,
        }),
      ).toThrow();
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'custom-rest-readonly',
        templateVersion: 1,
        fields: { endpoint: 'https://bücher.de', methods: ['GET'], paths: ['/v1/items'] },
      }).publicConfig.endpoint,
    ).toBe('https://xn--bcher-kva.de');
  });

  it('requires public-only pinned DNS answers and rejects rebinding', () => {
    const requirement = customDnsRequirement('api.example.com');
    for (const answers of [
      ['10.0.0.1'],
      ['169.254.169.254'],
      ['192.168.0.1'],
      ['192.0.0.1'],
      ['192.0.2.1'],
      ['192.88.99.1'],
      ['192.175.48.1'],
      ['198.51.100.1'],
      ['203.0.113.1'],
      ['224.0.0.0'],
      ['224.0.0.1'],
      ['239.255.255.255'],
      ['fe80::1'],
      ['fc00::1'],
      ['ff02::1'],
      ['0:0:0:0:0:ffff:7f00:1'],
      ['2001:db8::1'],
      ['2002:0a00:0001::1'],
      ['2620:4f:8000::1'],
      ['3fff:0000::1'],
      ['3fff:0fff::1'],
      ['3ffe::1'],
      ['3ffd::1'],
      ['2001:1ff::1'],
      ['23ff:ffff::1'],
      ['2420::1'],
      ['2612::1'],
      ['2622::1'],
      ['2d00::1'],
      ['not-an-ip'],
    ])
      expect(() => pinPublicDnsAnswers(requirement, answers)).toThrow();

    const pin = pinPublicDnsAnswers(requirement, ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']);
    expect(pin.addresses).toEqual([
      '1.1.1.1',
      '2606:4700:4700:0000:0000:0000:0000:1111',
      '8.8.8.8',
    ]);
    expect(Object.isFrozen(pin)).toBe(true);
    expect(Object.isFrozen(pin.addresses)).toBe(true);
    expect(() => {
      (pin as { hostname: string }).hostname = 'evil.test';
    }).toThrow();
    expect(() => {
      (pin as unknown as { addresses: string[] }).addresses = ['9.9.9.9'];
    }).toThrow();
    expect(() =>
      verifyPinnedPublicDns(pin, ['8.8.8.8', '1.1.1.1', '2606:4700:4700:0:0:0:0:1111']),
    ).not.toThrow();
    expect(() => verifyPinnedPublicDns(pin, ['1.1.1.1'])).toThrow('rebinding');
    expect(() => verifyPinnedPublicDns(pin, ['1.1.1.1', '9.9.9.9'])).toThrow('rebinding');
    expect(() => pinPublicDnsAnswers(requirement, ['2001:200::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['2400::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['241f:ffff::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['260f:ffff::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['2610::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['2620::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['2c00::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['198.51.99.255'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['198.51.101.0'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['203.0.112.255'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['203.0.114.0'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['192.0.1.1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['192.2.0.1'])).not.toThrow();
  });

  it('covers both bounds and immediate neighbors of every generated IANA CIDR', () => {
    const allCidrs = [
      ...ianaIpv4SpecialPurposeCidrs,
      ...ianaIpv6SpecialPurposeCidrs,
      ...ianaIpv6AllocatedGlobalUnicastCidrs,
    ];
    const ipv4Special = ianaIpv4SpecialPurposeCidrs.map(parseCidr);
    const ipv6Special = ianaIpv6SpecialPurposeCidrs.map(parseCidr);
    const ipv6Allocated = ianaIpv6AllocatedGlobalUnicastCidrs.map(parseCidr);
    const addressText = (address: bigint) =>
      Array.from({ length: 8 }, (_, index) =>
        Number((address >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
      ).join(':');
    const ipv4Text = (address: bigint) =>
      [24n, 16n, 8n, 0n].map((shift) => Number((address >> shift) & 0xffn)).join('.');
    const expectedPublic = (address: bigint, family: 4 | 6) => {
      const parsed = parseIpAddress(family === 4 ? ipv4Text(address) : addressText(address));
      if (!parsed) throw new Error('test address failed to parse');
      if (parsed.family === 4)
        return (
          !ipv4Special.some((cidr) => cidrContains(parsed, cidr)) &&
          parsed.value < parseIpAddress('224.0.0.0')!.value
        );
      return (
        ipv6Allocated.some((cidr) => cidrContains(parsed, cidr)) &&
        !ipv6Special.some((cidr) => cidrContains(parsed, cidr))
      );
    };
    const expectAddress = (address: bigint, family: 4 | 6) => {
      const text = family === 4 ? ipv4Text(address) : addressText(address);
      expect(canonicalPublicDnsAddress(text) !== undefined).toBe(expectedPublic(address, family));
    };

    for (const entry of allCidrs) {
      const cidr = parseCidr(entry);
      const bits = cidr.family === 4 ? 32 : 128;
      const hostBits = BigInt(bits - cidr.prefixLength);
      const lower = cidr.network;
      const upper = lower | ((1n << hostBits) - 1n);
      const max = (1n << BigInt(bits)) - 1n;
      expectAddress(lower, cidr.family);
      expectAddress(upper, cidr.family);
      if (lower > 0n) expectAddress(lower - 1n, cidr.family);
      if (upper < max) expectAddress(upper + 1n, cidr.family);
    }
  });

  it('accepts only IPv4 unicast addresses outside generated special-purpose ranges', () => {
    expect(canonicalPublicDnsAddress('223.255.255.255')).toBe('223.255.255.255');
    expect(canonicalPublicDnsAddress('224.0.0.0')).toBeUndefined();
    expect(canonicalPublicDnsAddress('239.255.255.255')).toBeUndefined();
    expect(canonicalPublicDnsAddress('240.0.0.0')).toBeUndefined();
  });

  it('keeps generated IANA data byte-integral with its checked-in snapshots', async () => {
    const expected = await loadIanaAddressData(process.cwd());
    expect(ianaAddressDataIntegrity.sourceDigests).toEqual(expected.sourceDigests);
    expect(ianaIpv4SpecialPurposeCidrs).toEqual(expected.ipv4SpecialPurposeCidrs);
    expect(ianaIpv6SpecialPurposeCidrs).toEqual(expected.ipv6SpecialPurposeCidrs);
    expect(ianaIpv6AllocatedGlobalUnicastCidrs).toEqual(expected.ipv6AllocatedGlobalUnicastCidrs);
  });

  it('reproduces the checked-in offline IANA table from its snapshots', async () => {
    const snapshots = await loadIanaAddressData(process.cwd());
    const generated = await readFile(
      fileURLToPath(new URL('../connections/iana-address-data.generated.ts', import.meta.url)),
      'utf8',
    );
    expect(renderIanaAddressData(snapshots, '2026-09-17')).toBe(generated);
  });

  it('rejects Git ref component escapes in reviewed base branches', () => {
    for (const branch of [
      'HEAD',
      'refs/heads/main',
      'a'.repeat(40),
      'A'.repeat(40),
      'foo/.hidden',
      'foo/bar.lock/baz',
      'foo/.lock/baz',
    ])
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'github-readonly',
          templateVersion: 1,
          fields: { allowedRepositories: ['acme/widget'], allowedBaseBranches: [branch] },
        }),
      ).toThrow('Invalid allowedBaseBranches');

    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'github-readonly',
        templateVersion: 1,
        fields: {
          allowedRepositories: ['acme/widget'],
          allowedBaseBranches: [
            'head',
            'Head',
            'a'.repeat(39),
            'a'.repeat(41),
            `${'a'.repeat(39)}g`,
          ],
        },
      }).publicConfig.allowedBaseBranches,
    ).toEqual(['head', 'Head', 'a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)}g`]);
  });

  it('fails closed for own-property handler lookup and bidirectional relationship drift', () => {
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, policyCompiler: 'constructor' }],
        capabilities: [],
      }),
    ).toThrow('Unknown policy compiler');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, probe: 'constructor' }],
        capabilities: [],
      }),
    ).toThrow('Unknown probe');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, policyCompiler: 'github-readonly-v1' }],
        capabilities: [],
      }),
    ).toThrow('does not match template version');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, probe: 'github-readonly-v1' }],
        capabilities: [],
      }),
    ).toThrow('does not match template version');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [{ ...githubPublish, executor: 'constructor' }],
      }),
    ).toThrow('Unknown capability executor');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [{ ...githubPublish, version: 2 }],
      }),
    ).toThrow('does not match template version');
    for (const provider of [
      { ...jira, risk: 'bounded-write' as const },
      { ...jira, credentialFields: [{ ...jira.credentialFields[0]!, required: false }] },
      { ...jira, connectionFields: [{ ...jira.connectionFields[0]!, required: false }] },
      { ...jira, label: 'Unreviewed Jira' },
      { ...jira, category: 'productivity' as const },
      { ...jira, description: 'Unreviewed scope.' },
      { ...jira, capabilityTemplates: [{ id: 'github.publish-pr', version: 1 }] },
    ])
      expect(() =>
        createConnectionTemplateRegistry({ providers: [provider], capabilities: [] }),
      ).toThrow('reviewed template contract');
    for (const capability of [
      {
        ...githubPublish,
        inputSchema: {
          ...githubPublish.inputSchema,
          properties: {
            ...githubPublish.inputSchema.properties,
            title: { type: 'string' as const, maxLength: 255 },
          },
        },
      },
      { ...githubPublish, approval: 'explicit-intent' as const },
      { ...githubPublish, label: 'Unreviewed publish' },
      { ...githubPublish, description: 'Unreviewed mutation.' },
    ])
      expect(() =>
        createConnectionTemplateRegistry({ providers: [github], capabilities: [capability] }),
      ).toThrow('reviewed template contract');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...github, capabilityTemplates: [] }],
        capabilities: [githubPublish],
      }),
    ).toThrow('reviewed template contract');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github, jira],
        capabilities: [
          { ...githubPublish, connectionTemplates: [{ id: 'jira-readonly', version: 1 }] },
        ],
      }),
    ).toThrow('reviewed template contract');
  });

  it('fails closed when a symbolic handler changes its reviewed golden policy output', () => {
    const original = reviewedHandlerBindings.compilers['jira-readonly-v1']!;
    expect(() =>
      createConnectionTemplateRegistry(
        { providers: [jira], capabilities: [] },
        {
          ...reviewedHandlerBindings,
          compilers: {
            ...reviewedHandlerBindings.compilers,
            'jira-readonly-v1': {
              ...original,
              handler: (template, fields) => ({
                ...original.handler(template, fields),
                publicConfig: { email: 'changed@example.com' },
              }),
            },
          },
        },
      ),
    ).toThrow('implementation does not match reviewed behavior');
  });

  it('binds handler source outside golden inputs to reviewed artifacts', async () => {
    const sources = Object.fromEntries(
      await Promise.all(
        Object.keys(reviewedHandlerSourceArtifacts).map(async (file) => [
          file,
          await readFile(fileURLToPath(new URL(`../connections/${file}`, import.meta.url)), 'utf8'),
        ]),
      ),
    ) as Record<keyof typeof reviewedHandlerSourceArtifacts, string>;
    for (const [file, expected] of Object.entries(reviewedHandlerSourceArtifacts))
      expect(reviewedHandlerSourceFingerprint(sources[file as keyof typeof sources])).toBe(
        expected,
      );

    // HEAD rejection is deliberately absent from the GitHub golden output.
    // A source-only validation change must still invalidate the reviewed artifact.
    expect(
      reviewedHandlerSourceFingerprint(
        sources['policy-compiler.ts'].replace('ambiguousGithubBaseBranches.has(value)', 'false'),
      ),
    ).not.toBe(reviewedHandlerSourceArtifacts['policy-compiler.ts']);
  });

  it('fails closed for duplicate and malformed manifests', () => {
    expect(() =>
      createConnectionTemplateRegistry({ providers: [jira, { ...jira }], capabilities: [] }),
    ).toThrow('Duplicate provider template version');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [githubPublish, { ...githubPublish }],
      }),
    ).toThrow('Duplicate capability template version');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [
          {
            ...github,
            credentialFields: [github.credentialFields[0]!, { ...github.credentialFields[0]! }],
          },
        ],
        capabilities: [githubPublish],
      }),
    ).toThrow('Duplicate credential field key');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, guidance: { ...jira.guidance!, href: 'http://example.test' } }],
        capabilities: [],
      }),
    ).toThrow('Invalid provider template');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [
          {
            ...githubPublish,
            inputSchema: { ...githubPublish.inputSchema, required: ['missingProperty'] },
          },
        ],
      }),
    ).toThrow('Invalid capability template');
    const tooWideInputSchema: JsonSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 13 }, (_, index) => [
          `actionableField${index}`,
          { type: 'string', maxLength: 512 },
        ]),
      ),
      required: Array.from({ length: 13 }, (_, index) => `actionableField${index}`),
      additionalProperties: false,
    };
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [{ ...githubPublish, inputSchema: tooWideInputSchema }],
      }),
    ).toThrow('cannot fit a complete approval projection');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [
          {
            ...githubPublish,
            inputSchema: {
              ...githubPublish.inputSchema,
              properties: {
                ...githubPublish.inputSchema.properties,
                title: { type: 'string', minLength: 257, maxLength: 256 },
              },
            },
          },
        ],
      }),
    ).toThrow('Invalid capability template');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [
          {
            ...githubPublish,
            inputSchema: {
              ...githubPublish.inputSchema,
              properties: {
                ...githubPublish.inputSchema.properties,
                draft: { type: 'boolean', minLength: 1 },
              },
            },
          },
        ],
      }),
    ).toThrow('Invalid capability template');
    for (const inherited of ['constructor', 'toString'])
      expect(() =>
        createConnectionTemplateRegistry({
          providers: [github],
          capabilities: [
            {
              ...githubPublish,
              inputSchema: { ...githubPublish.inputSchema, required: [inherited] },
            },
          ],
        }),
      ).toThrow('Invalid capability template');
  });
});
