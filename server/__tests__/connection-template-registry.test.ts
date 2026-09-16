import { describe, expect, it } from 'vitest';
import {
  connectionTemplateRegistry,
  createConnectionTemplateRegistry,
  projectCapabilityTemplate,
  projectProviderTemplate,
} from '../connections/registry.js';

const jira = connectionTemplateRegistry.getProviderTemplate('jira-readonly', 1)!;
const github = connectionTemplateRegistry.getProviderTemplate('github-readonly', 1)!;
const customRest = connectionTemplateRegistry.getProviderTemplate('custom-rest-readonly', 1)!;
const githubPublish = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1)!;

describe('connection template registry', () => {
  it('contains reviewed, versioned Jira, GitHub, custom REST, and GitHub publish manifests', () => {
    expect(connectionTemplateRegistry.providerTemplates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'jira-readonly', version: 1 }),
        expect.objectContaining({ id: 'github-readonly', version: 1 }),
        expect.objectContaining({ id: 'custom-rest-readonly', version: 1 }),
      ]),
    );
    expect(connectionTemplateRegistry.capabilityTemplates()).toEqual([
      expect.objectContaining({ id: 'github.publish-pr', version: 1, approval: 'always' }),
    ]);
    expect(connectionTemplateRegistry.getProviderTemplate('github-readonly', 2)).toBeUndefined();
    expect(
      connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 2),
    ).toBeUndefined();
  });

  it('projects only public display metadata, never secrets or execution identifiers', () => {
    const publicProvider = projectProviderTemplate(github);
    const publicCapability = projectCapabilityTemplate(githubPublish);
    const wire = JSON.stringify({ publicProvider, publicCapability });

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
  });

  it('compiles independently inspected endpoint policies for reviewed providers', () => {
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'jira-readonly',
        templateVersion: 1,
        fields: {},
      }),
    ).toMatchObject({
      endpoints: [
        expect.objectContaining({
          host: 'api.atlassian.com',
          protocol: 'rest',
          redirects: 'deny',
          allowedBinaries: expect.arrayContaining(['/usr/bin/curl']),
        }),
      ],
    });

    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'github-readonly',
        templateVersion: 1,
        fields: {},
      }).endpoints,
    ).toEqual([
      expect.objectContaining({
        host: 'api.github.com',
        protocol: 'rest',
        rules: expect.arrayContaining([expect.objectContaining({ method: 'GET' })]),
      }),
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

    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'custom-rest-readonly',
        templateVersion: 1,
        fields: {
          endpoint: 'https://api.example.com',
          methods: ['GET', 'HEAD'],
          paths: ['/v1/**'],
        },
      }),
    ).toMatchObject({
      endpoints: [
        {
          host: 'api.example.com',
          port: 443,
          protocol: 'rest',
          tls: 'terminate',
          redirects: 'deny',
          rules: [
            { method: 'GET', path: '/v1/**' },
            { method: 'HEAD', path: '/v1/**' },
          ],
          allowedBinaries: ['/usr/bin/curl', '/usr/local/bin/curl'],
        },
      ],
    });
  });

  it('rejects unsafe custom hosts, credentials, ports, wildcards, and mutation attempts', () => {
    const invalidFields: Array<Record<string, string | string[]>> = [
      { endpoint: 'http://api.example.com', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://127.0.0.1', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://[::1]', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://localhost', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://user:pass@api.example.com', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://api.example.com:8443', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://*.example.com', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://api.example.com', methods: ['POST'], paths: ['/v1/**'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['https://evil.example'] },
      {
        endpoint: 'https://api.example.com',
        methods: ['GET'],
        paths: ['/v1/**'],
        token: 'SENTINEL_SECRET',
      },
    ];
    for (const fields of invalidFields) {
      expect(() =>
        connectionTemplateRegistry.compileProviderPolicy({
          templateId: 'custom-rest-readonly',
          templateVersion: 1,
          fields,
        }),
      ).toThrow();
    }
  });

  it('fails closed for duplicate or malformed provider manifests', () => {
    expect(() =>
      createConnectionTemplateRegistry({ providers: [jira, { ...jira }], capabilities: [] }),
    ).toThrow('Duplicate provider template version');
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
        providers: [
          {
            ...customRest,
            connectionFields: customRest.connectionFields.map((field) =>
              field.key === 'methods' ? { ...field, kind: 'string' } : field,
            ),
          },
          github,
        ],
        capabilities: [githubPublish],
      }),
    ).toThrow('Invalid provider template');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, policyCompiler: 'unknown-compiler-v1' }],
        capabilities: [],
      }),
    ).toThrow('Unknown policy compiler');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, probe: 'unknown-probe-v1' }],
        capabilities: [],
      }),
    ).toThrow('Unknown probe');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, capabilityIds: ['unknown.capability'] }],
        capabilities: [],
      }),
    ).toThrow('Provider template references an unknown capability');
  });

  it('fails closed for duplicate, malformed, and unlinked capability manifests', () => {
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [githubPublish, { ...githubPublish }],
      }),
    ).toThrow('Duplicate capability template version');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [github],
        capabilities: [{ ...githubPublish, executor: 'unknown-executor-v1' }],
      }),
    ).toThrow('Unknown capability executor');
    expect(() =>
      createConnectionTemplateRegistry({ providers: [jira], capabilities: [githubPublish] }),
    ).toThrow('Capability template references an unknown provider');
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
        capabilities: [{ ...githubPublish, executor: 'node -e unsafe' }],
      }),
    ).toThrow('Invalid capability template');
  });
});
