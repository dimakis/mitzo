import { z } from 'zod';
import {
  compileCustomRestReadonly,
  compileGithubReadonly,
  compileJiraReadonly,
} from './policy-compiler.js';
import type {
  CapabilityExecutor,
  CapabilityTemplate,
  CompileProviderPolicyInput,
  JsonSchema,
  PolicyCompiler,
  Probe,
  ProviderTemplate,
  PublicCapabilityTemplate,
  PublicProviderTemplate,
} from './types.js';

const symbolicIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SymbolicIdentifier = z.string().regex(symbolicIdentifier);
const CredentialFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    style: z.enum(['bearer-token', 'api-token', 'basic', 'oauth2']),
    secret: z.literal(true),
    required: z.boolean(),
  })
  .strict();
const ConnectionFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    kind: z.enum(['string', 'email', 'url', 'string-list', 'enum-list']),
    required: z.boolean(),
    choices: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.kind === 'enum-list' && !field.choices)
      ctx.addIssue({ code: 'custom', message: 'enum-list fields require choices' });
    if (field.kind !== 'enum-list' && field.choices)
      ctx.addIssue({ code: 'custom', message: 'only enum-list fields may have choices' });
  });
const ProviderTemplateSchema = z
  .object({
    id: SymbolicIdentifier,
    version: z.number().int().positive(),
    label: z.string().min(1).max(120),
    category: z.enum(['source-control', 'productivity', 'data', 'custom-api']),
    description: z.string().min(1).max(500),
    risk: z.enum(['read-only', 'bounded-write', 'operator-defined']),
    credentialFields: z.array(CredentialFieldSchema).max(10),
    connectionFields: z.array(ConnectionFieldSchema).max(10),
    policyCompiler: SymbolicIdentifier,
    probe: SymbolicIdentifier,
    capabilityIds: z.array(SymbolicIdentifier).max(20),
  })
  .strict();
const JsonSchemaSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(
      z.string().regex(/^[a-z][A-Za-z0-9]*$/),
      z
        .object({
          type: z.enum(['string', 'boolean']),
          maxLength: z.number().int().positive().max(65_536).optional(),
        })
        .strict(),
    ),
    required: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/)).max(30),
    additionalProperties: z.literal(false),
  })
  .strict()
  .superRefine((schema, ctx) => {
    if (schema.required.some((key) => !(key in schema.properties)))
      ctx.addIssue({ code: 'custom', message: 'required input must be defined' });
  });
const CapabilityTemplateSchema = z
  .object({
    id: SymbolicIdentifier,
    version: z.number().int().positive(),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    connectionTemplateIds: z.array(SymbolicIdentifier).min(1).max(20),
    inputSchema: JsonSchemaSchema,
    executor: SymbolicIdentifier,
    approval: z.enum(['always', 'explicit-intent']),
    idempotency: z.literal('required'),
  })
  .strict();

function nullPrototypeHandlers<T>(
  entries: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}
const compilers: Readonly<Record<string, PolicyCompiler>> = nullPrototypeHandlers({
  'jira-readonly-v1': compileJiraReadonly,
  'github-readonly-v1': compileGithubReadonly,
  'custom-rest-readonly-v1': compileCustomRestReadonly,
});
const identityProbe: Probe = () => ({ kind: 'identity-and-scope' });
const probes: Readonly<Record<string, Probe>> = nullPrototypeHandlers({
  'jira-readonly-v1': identityProbe,
  'github-readonly-v1': identityProbe,
  'custom-rest-readonly-v1': identityProbe,
});
const approvalRequiredExecutor: CapabilityExecutor = () => ({ kind: 'approval-required' });
const executors: Readonly<Record<string, CapabilityExecutor>> = nullPrototypeHandlers({
  'github-publish-pr-v1': approvalRequiredExecutor,
});

function key(id: string, version: number) {
  return `${id}@${version}`;
}
function uniqueKeys(items: readonly { key: string }[], field: string) {
  if (new Set(items.map((item) => item.key)).size !== items.length)
    throw new Error(`Duplicate ${field} key`);
}
function parseProviderTemplate(value: unknown): ProviderTemplate {
  const parsed = ProviderTemplateSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid provider template');
  const template = parsed.data as ProviderTemplate;
  uniqueKeys(template.credentialFields, 'credential field');
  uniqueKeys(template.connectionFields, 'connection field');
  if (new Set(template.capabilityIds).size !== template.capabilityIds.length)
    throw new Error('Provider template has duplicate capability identifiers');
  return Object.freeze({
    ...template,
    credentialFields: Object.freeze(
      template.credentialFields.map((field) => Object.freeze({ ...field })),
    ),
    connectionFields: Object.freeze(
      template.connectionFields.map((field) =>
        Object.freeze({
          ...field,
          ...(field.choices ? { choices: Object.freeze([...field.choices]) } : {}),
        }),
      ),
    ),
    capabilityIds: Object.freeze([...template.capabilityIds]),
  });
}
function parseCapabilityTemplate(value: unknown): CapabilityTemplate {
  const parsed = CapabilityTemplateSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid capability template');
  const template = parsed.data as CapabilityTemplate;
  if (new Set(template.connectionTemplateIds).size !== template.connectionTemplateIds.length)
    throw new Error('Capability template has duplicate connection template identifiers');
  return Object.freeze({
    ...template,
    connectionTemplateIds: Object.freeze([...template.connectionTemplateIds]),
    inputSchema: Object.freeze({
      ...template.inputSchema,
      properties: Object.freeze(
        Object.fromEntries(
          Object.entries(template.inputSchema.properties).map(([name, property]) => [
            name,
            Object.freeze({ ...property }),
          ]),
        ),
      ),
      required: Object.freeze([...template.inputSchema.required]),
    }) as JsonSchema,
  });
}
function requireSymbolicHandler(
  name: string,
  handlers: Readonly<Record<string, unknown>>,
  kind: string,
) {
  if (!symbolicIdentifier.test(name)) throw new Error(`${kind} must be a safe symbolic identifier`);
  if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown ${kind}`);
}

export function projectProviderTemplate(template: ProviderTemplate): PublicProviderTemplate {
  return {
    id: template.id,
    version: template.version,
    label: template.label,
    category: template.category,
    description: template.description,
    risk: template.risk,
    credentialFields: template.credentialFields.map((field) => ({ ...field })),
    connectionFields: template.connectionFields.map((field) => ({
      ...field,
      ...(field.choices ? { choices: [...field.choices] } : {}),
    })),
    capabilityIds: [...template.capabilityIds],
  };
}
export function projectCapabilityTemplate(template: CapabilityTemplate): PublicCapabilityTemplate {
  return {
    id: template.id,
    version: template.version,
    label: template.label,
    description: template.description,
    connectionTemplateIds: [...template.connectionTemplateIds],
    approval: template.approval,
    idempotency: template.idempotency,
  };
}

export function createConnectionTemplateRegistry(input: {
  providers: readonly unknown[];
  capabilities: readonly unknown[];
}) {
  const providers = input.providers.map(parseProviderTemplate);
  const capabilities = input.capabilities.map(parseCapabilityTemplate);
  const providerByKey = new Map(
    providers.map((template) => [key(template.id, template.version), template]),
  );
  const capabilityByKey = new Map(
    capabilities.map((template) => [key(template.id, template.version), template]),
  );
  if (providerByKey.size !== providers.length)
    throw new Error('Duplicate provider template version');
  if (capabilityByKey.size !== capabilities.length)
    throw new Error('Duplicate capability template version');
  const providerIds = new Set(providers.map((template) => template.id));
  const capabilityIds = new Set(capabilities.map((template) => template.id));
  for (const provider of providers) {
    requireSymbolicHandler(provider.policyCompiler, compilers, 'policy compiler');
    requireSymbolicHandler(provider.probe, probes, 'probe');
    if (provider.capabilityIds.some((id) => !capabilityIds.has(id)))
      throw new Error('Provider template references an unknown capability');
  }
  for (const capability of capabilities) {
    requireSymbolicHandler(capability.executor, executors, 'capability executor');
    if (capability.connectionTemplateIds.some((id) => !providerIds.has(id)))
      throw new Error('Capability template references an unknown provider');
  }
  for (const provider of providers) {
    for (const capabilityId of provider.capabilityIds) {
      const capability = capabilities.filter((candidate) => candidate.id === capabilityId);
      if (
        capability.length === 0 ||
        capability.some((candidate) => !candidate.connectionTemplateIds.includes(provider.id))
      )
        throw new Error('Provider and capability relationship must be bidirectional');
    }
  }
  for (const capability of capabilities) {
    for (const providerId of capability.connectionTemplateIds) {
      const provider = providers.filter((candidate) => candidate.id === providerId);
      if (
        provider.length === 0 ||
        provider.some((candidate) => !candidate.capabilityIds.includes(capability.id))
      )
        throw new Error('Provider and capability relationship must be bidirectional');
    }
  }

  return Object.freeze({
    providerTemplates: (): readonly PublicProviderTemplate[] =>
      providers.map(projectProviderTemplate),
    capabilityTemplates: (): readonly PublicCapabilityTemplate[] =>
      capabilities.map(projectCapabilityTemplate),
    getProviderTemplate: (id: string, version: number) => providerByKey.get(key(id, version)),
    getCapabilityTemplate: (id: string, version: number) => capabilityByKey.get(key(id, version)),
    compileProviderPolicy: (compileInput: CompileProviderPolicyInput) => {
      const template = providerByKey.get(
        key(compileInput.templateId, compileInput.templateVersion),
      );
      if (!template) throw new Error('Unknown provider template version');
      if (!compileInput.fields || Array.isArray(compileInput.fields))
        throw new Error('Provider fields must be an object');
      return compilers[template.policyCompiler]!(
        template,
        Object.freeze({ ...compileInput.fields }),
      );
    },
    probeFor: (id: string, version: number) => {
      const template = providerByKey.get(key(id, version));
      if (!template) throw new Error('Unknown provider template version');
      return probes[template.probe]!(template);
    },
    executorFor: (id: string, version: number) => {
      const template = capabilityByKey.get(key(id, version));
      if (!template) throw new Error('Unknown capability template version');
      return executors[template.executor]!(template);
    },
  });
}

const providers: readonly ProviderTemplate[] = [
  {
    id: 'jira-readonly',
    version: 1,
    label: 'Jira',
    category: 'data',
    description: 'Read issues and project metadata from the reviewed Jira scope.',
    risk: 'read-only',
    credentialFields: [
      {
        key: 'token',
        label: 'API token',
        description: 'A one-shot Jira API token used only by the gateway.',
        style: 'api-token',
        secret: true,
        required: true,
      },
    ],
    connectionFields: [
      {
        key: 'email',
        label: 'Jira email',
        description: 'The account email used with the one-shot Jira API token.',
        kind: 'email',
        required: true,
      },
    ],
    policyCompiler: 'jira-readonly-v1',
    probe: 'jira-readonly-v1',
    capabilityIds: [],
  },
  {
    id: 'github-readonly',
    version: 1,
    label: 'GitHub',
    category: 'source-control',
    description: 'Read GitHub repositories through the reviewed read-only provider profile.',
    risk: 'read-only',
    credentialFields: [
      {
        key: 'token',
        label: 'Access token',
        description: 'A one-shot GitHub token used only by the gateway.',
        style: 'bearer-token',
        secret: true,
        required: true,
      },
    ],
    connectionFields: [
      {
        key: 'allowedRepositories',
        label: 'Allowed repositories',
        description:
          'Exact owner/repository pairs eligible for the publish pull request capability.',
        kind: 'string-list',
        required: true,
      },
      {
        key: 'allowedBaseBranches',
        label: 'Allowed base branches',
        description: 'Exact base branches eligible for the publish pull request capability.',
        kind: 'string-list',
        required: true,
      },
    ],
    policyCompiler: 'github-readonly-v1',
    probe: 'github-readonly-v1',
    capabilityIds: ['github.publish-pr'],
  },
  {
    id: 'custom-rest-readonly',
    version: 1,
    label: 'Custom REST API',
    category: 'custom-api',
    description:
      'Operator-defined HTTPS REST reads using an intentionally small reviewed policy subset.',
    risk: 'operator-defined',
    credentialFields: [
      {
        key: 'token',
        label: 'Access token',
        description: 'A one-shot API token used only by the gateway.',
        style: 'bearer-token',
        secret: true,
        required: true,
      },
    ],
    connectionFields: [
      {
        key: 'endpoint',
        label: 'HTTPS endpoint',
        description: 'Exact public HTTPS origin; private, local, and IP hosts are rejected.',
        kind: 'url',
        required: true,
      },
      {
        key: 'methods',
        label: 'Read methods',
        description: 'Only reviewed read methods are available.',
        kind: 'enum-list',
        required: true,
        choices: ['GET', 'HEAD', 'OPTIONS'],
      },
      {
        key: 'paths',
        label: 'Allowed paths',
        description: 'Absolute path patterns only.',
        kind: 'string-list',
        required: true,
      },
    ],
    policyCompiler: 'custom-rest-readonly-v1',
    probe: 'custom-rest-readonly-v1',
    capabilityIds: [],
  },
];
const capabilities: readonly CapabilityTemplate[] = [
  {
    id: 'github.publish-pr',
    version: 1,
    label: 'Publish pull request',
    description:
      'Publish already-committed work to an approved feature branch after explicit approval.',
    connectionTemplateIds: ['github-readonly'],
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', maxLength: 128 },
        repositoryPath: { type: 'string', maxLength: 1024 },
        baseBranch: { type: 'string', maxLength: 255 },
        title: { type: 'string', maxLength: 256 },
        body: { type: 'string', maxLength: 65_536 },
        draft: { type: 'boolean' },
      },
      required: ['connectionId', 'repositoryPath', 'baseBranch', 'title', 'body', 'draft'],
      additionalProperties: false,
    },
    executor: 'github-publish-pr-v1',
    approval: 'always',
    idempotency: 'required',
  },
];

export const connectionTemplateRegistry = createConnectionTemplateRegistry({
  providers,
  capabilities,
});
