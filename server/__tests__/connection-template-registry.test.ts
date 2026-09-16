import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_REGISTRY,
  TemplateRegistry,
  createTemplateRegistry,
} from '../connections/registry.js';
import {
  CAPABILITY_TEMPLATES,
  PROVIDER_TEMPLATES,
  type CapabilityTemplate,
  type ProviderTemplate,
} from '../connections/types.js';

describe('connection template registry', () => {
  it('ships reviewed, versioned Jira, GitHub, and operator-only custom REST templates', () => {
    const catalog = TEMPLATE_REGISTRY.listProviders();

    expect(catalog.map((template) => `${template.id}@${template.version}`)).toEqual([
      'custom-rest-readonly@1',
      'github-readonly@1',
      'jira-readonly@1',
    ]);
    expect(TEMPLATE_REGISTRY.resolveProvider('jira-readonly', 1)?.risk).toBe('read-only');
    expect(TEMPLATE_REGISTRY.resolveProvider('github-readonly', 1)?.category).toBe(
      'source-control',
    );
    expect(TEMPLATE_REGISTRY.resolveProvider('custom-rest-readonly', 1)?.operatorOnly).toBe(true);
    expect(TEMPLATE_REGISTRY.resolveCapability('github.publish-pr', 1)?.approval).toBe('always');
    expect(TEMPLATE_REGISTRY.resolveCapability('github.publish-pr', 1)?.idempotency).toBe(
      'required',
    );
  });

  it('publishes an explicit metadata projection without implementation bindings or credentials', () => {
    const projected = TEMPLATE_REGISTRY.listProviders();
    const serialized = JSON.stringify(projected);

    expect(projected[0]).not.toHaveProperty('policyCompiler');
    expect(projected[0]).not.toHaveProperty('probe');
    expect(serialized).not.toContain('JIRA_API_TOKEN');
    expect(serialized).not.toContain('GITHUB_TOKEN');
    expect(serialized).not.toContain('"gateway":');
    expect(serialized).not.toContain('executor');
    expect(serialized).not.toContain('SENTINEL_SECRET');
  });

  it('resolves implementations only from code-owned symbolic identifiers', () => {
    expect(TEMPLATE_REGISTRY.compilerFor('jira-readonly', 1)).toBeTypeOf('function');
    expect(TEMPLATE_REGISTRY.probeFor('github-readonly', 1)).toBeTypeOf('function');
    expect(TEMPLATE_REGISTRY.executorFor('github.publish-pr', 1)).toBeTypeOf('function');
  });

  it('compiles the bounded custom REST fixture and fails closed for unsafe policy input', () => {
    expect(
      TEMPLATE_REGISTRY.compileProvider('custom-rest-readonly', 1, {
        endpoint: 'https://api.example.com',
        methods: ['GET', 'HEAD'],
        paths: ['/v1/widgets/**'],
        credentialStyle: 'bearer',
        binaries: ['/usr/bin/curl'],
      }),
    ).toMatchObject({
      endpoint: { host: 'api.example.com', port: 443, protocol: 'rest', tls: 'terminate' },
      rules: [
        { method: 'GET', path: '/v1/widgets/**' },
        { method: 'HEAD', path: '/v1/widgets/**' },
      ],
    });

    for (const endpoint of [
      'http://api.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://user:password@api.example.com',
      'https://api.example.com:8443',
      'https://*.com',
    ]) {
      expect(() =>
        TEMPLATE_REGISTRY.compileProvider('custom-rest-readonly', 1, {
          endpoint,
          methods: ['POST'],
          paths: ['/v1/../admin'],
          credentialStyle: 'bearer',
          binaries: ['/bin/sh'],
          arbitrary: 'not allowed',
        }),
      ).toThrow(/invalid custom rest policy/i);
    }
  });

  it('keeps fixed Jira and GitHub fixtures read-only and rejects undeclared fields', () => {
    expect(
      TEMPLATE_REGISTRY.compileProvider('jira-readonly', 1, { email: 'user@example.com' }),
    ).toMatchObject({
      endpoint: { host: 'api.atlassian.com', protocol: 'rest' },
      credential: { envVar: 'JIRA_API_TOKEN', authStyle: 'basic' },
    });
    expect(
      TEMPLATE_REGISTRY.compileProvider('github-readonly', 1, {
        repositories: ['openai/mitzo'],
        baseBranches: ['main'],
      }),
    ).toMatchObject({
      endpoint: { host: 'api.github.com', protocol: 'rest' },
      credential: { envVar: 'GITHUB_TOKEN', authStyle: 'bearer' },
    });
    expect(() =>
      TEMPLATE_REGISTRY.compileProvider('jira-readonly', 1, {
        email: 'user@example.com',
        binary: '/bin/sh',
      }),
    ).toThrow(/invalid jira policy input/i);
    expect(() =>
      TEMPLATE_REGISTRY.compileProvider('github-readonly', 1, {
        repositories: ['openai/mitzo'],
        baseBranches: ['main'],
        method: 'POST',
      }),
    ).toThrow(/invalid github policy input/i);
  });

  it('rejects unknown manifest fields and missing implementation bindings', () => {
    const provider = structuredClone(PROVIDER_TEMPLATES[0]) as ProviderTemplate & {
      unexpected?: string;
    };
    provider.unexpected = 'fail closed';
    expect(() =>
      createTemplateRegistry({
        providers: [provider],
        capabilities: [],
      }),
    ).toThrow(/invalid provider template/i);

    const unbound = structuredClone(PROVIDER_TEMPLATES[0]);
    unbound.policyCompiler = 'not-registered-v1';
    expect(() =>
      createTemplateRegistry({
        providers: [unbound],
        capabilities: [],
      }),
    ).toThrow(/compiler/i);
  });

  it('rejects unsafe symbolic identifiers, duplicate versions, and unreviewed capability links', () => {
    const unsafe = structuredClone(PROVIDER_TEMPLATES[0]);
    unsafe.policyCompiler = '../../bin/sh';
    expect(() => new TemplateRegistry([unsafe], [], {})).toThrow(/identifier/i);

    const duplicate = structuredClone(PROVIDER_TEMPLATES[0]);
    expect(() => new TemplateRegistry([PROVIDER_TEMPLATES[0], duplicate], [], {})).toThrow(
      /duplicate/i,
    );

    const unreviewed = structuredClone(PROVIDER_TEMPLATES[1]);
    unreviewed.capabilityIds = ['github.unreviewed'];
    expect(() => new TemplateRegistry([unreviewed], [], {})).toThrow(/capability/i);
  });

  it('rejects capability templates that reference unsafe executors or incompatible providers', () => {
    const unsafe = structuredClone(CAPABILITY_TEMPLATES[0]);
    unsafe.executor = 'node --eval';
    expect(() =>
      createTemplateRegistry({ providers: PROVIDER_TEMPLATES, capabilities: [unsafe] }),
    ).toThrow(/identifier/i);

    const incompatible = structuredClone(CAPABILITY_TEMPLATES[0]) as CapabilityTemplate;
    incompatible.connectionTemplateIds = ['jira-readonly'];
    expect(() =>
      createTemplateRegistry({ providers: PROVIDER_TEMPLATES, capabilities: [incompatible] }),
    ).toThrow(/capability.*reviewed|does not expose/i);
  });

  it('returns immutable copies so callers cannot change the reviewed catalog', () => {
    const template = TEMPLATE_REGISTRY.resolveProvider('jira-readonly', 1)!;
    expect(() => {
      (template as { label: string }).label = 'Changed';
    }).toThrow();
    expect(TEMPLATE_REGISTRY.resolveProvider('jira-readonly', 1)?.label).toBe('Jira');
  });
});
