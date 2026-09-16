import { describe, expect, it } from 'vitest';
import {
  connectionTemplateRegistry,
  createConnectionTemplateRegistry,
  projectCapabilityTemplate,
  projectProviderTemplate,
} from '../connections/registry.js';

describe('connection template registry', () => {
  it('contains the reviewed versioned Jira, GitHub, custom REST, and GitHub publish manifests', () => {
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
  });

  it('projects only public display metadata and never secrets or host execution identifiers', () => {
    const provider = connectionTemplateRegistry.getProviderTemplate('github-readonly', 1);
    const capability = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1);
    expect(provider).toBeDefined();
    expect(capability).toBeDefined();

    const publicProvider = projectProviderTemplate(provider!);
    const publicCapability = projectCapabilityTemplate(capability!);
    const wire = JSON.stringify({ publicProvider, publicCapability });

    expect(wire).not.toContain('policyCompiler');
    expect(wire).not.toContain('probe');
    expect(wire).not.toContain('executor');
    expect(wire).not.toContain('GITHUB_TOKEN');
    expect(publicProvider.credentialFields[0]).toEqual(
      expect.objectContaining({ key: 'token', secret: true }),
    );
  });

  it('compiles reviewed policies without accepting credential values or arbitrary commands', () => {
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'jira-readonly',
        templateVersion: 1,
        fields: {},
      }),
    ).toMatchObject({
      templateId: 'jira-readonly',
      endpoint: {
        host: 'api.atlassian.com',
        port: 443,
        protocol: 'rest',
        tls: 'terminate',
        redirects: 'deny',
      },
    });

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
      endpoint: {
        host: 'api.example.com',
        port: 443,
        protocol: 'rest',
        tls: 'terminate',
        redirects: 'deny',
      },
      rules: [
        { method: 'GET', path: '/v1/**' },
        { method: 'HEAD', path: '/v1/**' },
      ],
    });

    const invalidFields: Array<Record<string, string | string[]>> = [
      { endpoint: 'http://api.example.com', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://127.0.0.1', methods: ['GET'], paths: ['/v1/**'] },
      { endpoint: 'https://api.example.com', methods: ['POST'], paths: ['/v1/**'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['https://evil.example'] },
      { endpoint: 'https://api.example.com', methods: ['GET'], paths: ['/v1/**'], token: 'secret' },
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

  it('rejects unsafe or unknown manifest fields and non-symbolic execution references', () => {
    const jira = connectionTemplateRegistry.getProviderTemplate('jira-readonly', 1)!;
    const githubPublish = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1)!;

    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, policyCompiler: '../bin/sh' }],
        capabilities: [githubPublish],
      }),
    ).toThrow('Invalid provider template');
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [{ ...jira, unexpected: true }],
        capabilities: [githubPublish],
      }),
    ).toThrow(/invalid provider template/i);
    expect(() =>
      createConnectionTemplateRegistry({
        providers: [jira],
        capabilities: [{ ...githubPublish, executor: 'node -e unsafe' }],
      }),
    ).toThrow('Invalid capability template');
  });
});
