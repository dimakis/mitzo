import { describe, expect, it } from 'vitest';
import {
  customDnsRequirement,
  pinPublicDnsAnswers,
  verifyPinnedPublicDns,
} from '../connections/policy-compiler.js';
import {
  connectionTemplateRegistry,
  createConnectionTemplateRegistry,
  projectCapabilityTemplate,
  projectProviderTemplate,
  validateVersionedTemplateRelationships,
} from '../connections/registry.js';

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
    const wire = JSON.stringify({
      provider: projectProviderTemplate(github),
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
        endpoint: 'https://api.example.com',
        methods: ['GET', 'GET', 'HEAD'],
        paths: ['/v1/items', '/v1/items'],
      },
    });
    expect(policy.endpoints).toMatchObject([
      {
        host: 'api.example.com',
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
      endpoint: 'https://api.example.com',
      methods: ['GET', 'HEAD'],
      paths: ['/v1/items'],
    });

    for (const fields of [
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1/../admin'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1//admin'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1/%2e%2e/admin'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1\\admin'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1/'] },
      {
        endpoint: 'https://api.example.com',
        methods: ['GET', 'HEAD', 'OPTIONS', 'GET'],
        paths: ['/v1/items'],
      },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: [`/${'a'.repeat(257)}`] },
      {
        endpoint: 'https://api.example.com',
        methods: ['GET'],
        paths: Array.from({ length: 21 }, (_, index) => `/v1/${index}`),
      },
      {
        endpoint: 'https://api.example.com',
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
      { endpoint: 'https://service.local', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://service.internal', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://user:pass@api.example.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.example.com:8443', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://*.example.com', methods: ['GET'], paths: ['/v1/items'] },
      { endpoint: 'https://api.example.com', methods: ['POST'], paths: ['/v1/items'] },
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
  });

  it('requires public-only pinned DNS answers and rejects rebinding', () => {
    const requirement = customDnsRequirement('api.example.com');
    for (const answers of [
      ['10.0.0.1'],
      ['169.254.169.254'],
      ['192.168.0.1'],
      ['192.0.2.1'],
      ['192.88.99.1'],
      ['198.51.100.1'],
      ['203.0.113.1'],
      ['fe80::1'],
      ['fc00::1'],
      ['ff02::1'],
      ['0:0:0:0:0:ffff:7f00:1'],
      ['2001:db8::1'],
      ['2002:0a00:0001::1'],
      ['3fff:0000::1'],
      ['3fff:0fff::1'],
      ['not-an-ip'],
    ])
      expect(() => pinPublicDnsAnswers(requirement, answers)).toThrow();

    const pin = pinPublicDnsAnswers(requirement, ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']);
    expect(pin.addresses).toEqual([
      '1.1.1.1',
      '2606:4700:4700:0000:0000:0000:0000:1111',
      '8.8.8.8',
    ]);
    expect(() =>
      verifyPinnedPublicDns(pin, ['8.8.8.8', '1.1.1.1', '2606:4700:4700:0:0:0:0:1111']),
    ).not.toThrow();
    expect(() => verifyPinnedPublicDns(pin, ['1.1.1.1'])).toThrow('rebinding');
    expect(() => verifyPinnedPublicDns(pin, ['1.1.1.1', '9.9.9.9'])).toThrow('rebinding');
    expect(() => pinPublicDnsAnswers(requirement, ['3fff:1000::1'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['198.51.99.255'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['198.51.101.0'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['203.0.112.255'])).not.toThrow();
    expect(() => pinPublicDnsAnswers(requirement, ['203.0.114.0'])).not.toThrow();
  });

  it('rejects Git ref component escapes in reviewed base branches', () => {
    for (const branch of ['foo/.hidden', 'foo/bar.lock/baz', 'foo/.lock/baz'])
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'github-readonly',
          templateVersion: 1,
          fields: { allowedRepositories: ['acme/widget'], allowedBaseBranches: [branch] },
        }),
      ).toThrow('Invalid allowedBaseBranches');
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
        providers: [github],
        capabilities: [
          {
            ...githubPublish,
            inputSchema: { ...githubPublish.inputSchema, required: ['missingProperty'] },
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
