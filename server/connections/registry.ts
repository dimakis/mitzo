import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  compileCustomRestReadonly,
  compileGithubReadonly,
  compileJiraReadonly,
} from './policy-compiler.js';
import { reviewedHandlerImplementationRevision } from './reviewed-handler-artifacts.js';
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
import { assertCompleteApprovalProjection } from './capabilities/approval-contract.js';

type BoundHandler<T> = Readonly<{
  templateKey: string;
  contract: string;
  /** Explicit reviewed implementation revision for this template version. */
  implementationRevision: string;
  /** SHA-256 of the revision and a representative, non-secret golden output. */
  expectedOutputFingerprint: string;
  goldenOutput: (template: ProviderTemplate | CapabilityTemplate, handler: T) => unknown;
  handler: T;
}>;
export type ReviewedHandlerBindings = Readonly<{
  compilers: Readonly<Record<string, BoundHandler<PolicyCompiler>>>;
  probes: Readonly<Record<string, BoundHandler<Probe>>>;
  executors: Readonly<Record<string, BoundHandler<CapabilityExecutor>>>;
}>;

const symbolicIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SymbolicIdentifier = z.string().max(120).regex(symbolicIdentifier);
const TemplateReferenceSchema = z
  .object({ id: SymbolicIdentifier, version: z.number().int().positive() })
  .strict();
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
const ProviderGuidanceSchema = z
  .object({
    body: z.string().min(1).max(500),
    href: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:', 'guidance must use HTTPS'),
    linkLabel: z.string().min(1).max(120),
  })
  .strict();
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
    capabilityTemplates: z.array(TemplateReferenceSchema).max(20),
    guidance: ProviderGuidanceSchema.optional(),
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
          minLength: z.number().int().positive().max(65_536).optional(),
          maxLength: z.number().int().positive().max(65_536).optional(),
        })
        .strict(),
    ),
    required: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/)).max(30),
    additionalProperties: z.literal(false),
  })
  .strict()
  .superRefine((schema, ctx) => {
    if (schema.required.some((key) => !Object.hasOwn(schema.properties, key)))
      ctx.addIssue({ code: 'custom', message: 'required input must be defined' });
    for (const property of Object.values(schema.properties)) {
      if (
        property.type !== 'string' &&
        (property.minLength !== undefined || property.maxLength !== undefined)
      )
        ctx.addIssue({ code: 'custom', message: 'only string inputs may have length bounds' });
      if (
        property.minLength !== undefined &&
        property.maxLength !== undefined &&
        property.minLength > property.maxLength
      )
        ctx.addIssue({ code: 'custom', message: 'minimum input length exceeds maximum' });
    }
  });
const CapabilityTemplateSchema = z
  .object({
    id: SymbolicIdentifier,
    version: z.number().int().positive().max(999_999_999),
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    connectionTemplates: z.array(TemplateReferenceSchema).min(1).max(20),
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
function key(id: string, version: number) {
  return `${id}@${version}`;
}
function contractFingerprint(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new Error('Reviewed manifest contains an unsupported value');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(contractFingerprint).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${contractFingerprint(record[name])}`)
    .join(',')}}`;
}
function implementationOutputFingerprint(implementationRevision: string, output: unknown) {
  return createHash('sha256')
    .update(contractFingerprint({ implementationRevision, output }))
    .digest('hex');
}
function providerHandlerContract(
  template: Pick<
    ProviderTemplate,
    | 'id'
    | 'version'
    | 'label'
    | 'category'
    | 'description'
    | 'risk'
    | 'credentialFields'
    | 'connectionFields'
    | 'capabilityTemplates'
    | 'guidance'
  >,
) {
  return contractFingerprint({
    id: template.id,
    version: template.version,
    label: template.label,
    category: template.category,
    description: template.description,
    risk: template.risk,
    credentialFields: template.credentialFields,
    connectionFields: template.connectionFields,
    capabilityTemplates: template.capabilityTemplates,
    ...(template.guidance ? { guidance: template.guidance } : {}),
  });
}
function capabilityHandlerContract(
  template: Pick<
    CapabilityTemplate,
    | 'id'
    | 'version'
    | 'label'
    | 'description'
    | 'connectionTemplates'
    | 'inputSchema'
    | 'approval'
    | 'idempotency'
  >,
) {
  return contractFingerprint({
    id: template.id,
    version: template.version,
    label: template.label,
    description: template.description,
    connectionTemplates: template.connectionTemplates,
    inputSchema: template.inputSchema,
    approval: template.approval,
    idempotency: template.idempotency,
  });
}
function handlerContract(template: ProviderTemplate | CapabilityTemplate) {
  return 'credentialFields' in template
    ? providerHandlerContract(template)
    : capabilityHandlerContract(template);
}
function bindHandler<T>(
  templateKey: string,
  contract: string,
  implementationRevision: string,
  expectedOutputFingerprint: string,
  goldenOutput: (template: ProviderTemplate | CapabilityTemplate, handler: T) => unknown,
  handler: T,
): BoundHandler<T> {
  return Object.freeze({
    templateKey,
    contract,
    implementationRevision,
    expectedOutputFingerprint,
    goldenOutput,
    handler,
  });
}
function uniqueKeys(items: readonly { key: string }[], field: string) {
  if (new Set(items.map((item) => item.key)).size !== items.length)
    throw new Error(`Duplicate ${field} key`);
}
function uniqueTemplateReferences(
  items: readonly { id: string; version: number }[],
  field: string,
) {
  if (new Set(items.map((item) => key(item.id, item.version))).size !== items.length)
    throw new Error(`Duplicate ${field}`);
}
function parseProviderTemplate(value: unknown): ProviderTemplate {
  const parsed = ProviderTemplateSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid provider template');
  const template = parsed.data as ProviderTemplate;
  uniqueKeys(template.credentialFields, 'credential field');
  uniqueKeys(template.connectionFields, 'connection field');
  uniqueTemplateReferences(template.capabilityTemplates, 'provider capability template reference');
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
    capabilityTemplates: Object.freeze(
      template.capabilityTemplates.map((reference) => Object.freeze({ ...reference })),
    ),
  });
}
function parseCapabilityTemplate(value: unknown): CapabilityTemplate {
  const parsed = CapabilityTemplateSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid capability template');
  const template = parsed.data as CapabilityTemplate;
  uniqueTemplateReferences(template.connectionTemplates, 'capability provider template reference');
  assertCompleteApprovalProjection(template.inputSchema);
  return Object.freeze({
    ...template,
    connectionTemplates: Object.freeze(
      template.connectionTemplates.map((reference) => Object.freeze({ ...reference })),
    ),
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
function requireSymbolicHandler<T>(
  name: string,
  handlers: Readonly<Record<string, BoundHandler<T>>>,
  kind: string,
) {
  if (!symbolicIdentifier.test(name)) throw new Error(`${kind} must be a safe symbolic identifier`);
  if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown ${kind}`);
  return handlers[name]!;
}
function requireBoundSymbolicHandler<T>(
  name: string,
  handlers: Readonly<Record<string, BoundHandler<T>>>,
  kind: string,
  template: ProviderTemplate | CapabilityTemplate,
) {
  const binding = requireSymbolicHandler(name, handlers, kind);
  if (binding.templateKey !== key(template.id, template.version))
    throw new Error(`${kind} does not match template version`);
  if (binding.contract !== handlerContract(template))
    throw new Error(`${kind} does not match reviewed template contract`);
  if (
    implementationOutputFingerprint(
      binding.implementationRevision,
      binding.goldenOutput(template, binding.handler),
    ) !== binding.expectedOutputFingerprint
  )
    throw new Error(`${kind} implementation does not match reviewed behavior`);
  return binding.handler;
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
    capabilityTemplates: template.capabilityTemplates.map((reference) => ({ ...reference })),
    ...(template.guidance ? { guidance: { ...template.guidance } } : {}),
  };
}
export function projectCapabilityTemplate(template: CapabilityTemplate): PublicCapabilityTemplate {
  return {
    id: template.id,
    version: template.version,
    label: template.label,
    description: template.description,
    connectionTemplates: template.connectionTemplates.map((reference) => ({ ...reference })),
    approval: template.approval,
    idempotency: template.idempotency,
  };
}

export function validateVersionedTemplateRelationships(
  providers: readonly ProviderTemplate[],
  capabilities: readonly CapabilityTemplate[],
) {
  const providerByKey = new Map(
    providers.map((template) => [key(template.id, template.version), template]),
  );
  const capabilityByKey = new Map(
    capabilities.map((template) => [key(template.id, template.version), template]),
  );
  for (const provider of providers)
    if (
      provider.capabilityTemplates.some(
        (reference) => !capabilityByKey.has(key(reference.id, reference.version)),
      )
    )
      throw new Error('Provider template references an unknown capability');
  for (const capability of capabilities)
    if (
      capability.connectionTemplates.some(
        (reference) => !providerByKey.has(key(reference.id, reference.version)),
      )
    )
      throw new Error('Capability template references an unknown provider');
  for (const provider of providers) {
    for (const capabilityReference of provider.capabilityTemplates) {
      const capability = capabilityByKey.get(
        key(capabilityReference.id, capabilityReference.version),
      );
      if (
        !capability ||
        !capability.connectionTemplates.some(
          (reference) =>
            key(reference.id, reference.version) === key(provider.id, provider.version),
        )
      )
        throw new Error('Provider and capability relationship must be bidirectional');
    }
  }
  for (const capability of capabilities) {
    for (const providerReference of capability.connectionTemplates) {
      const provider = providerByKey.get(key(providerReference.id, providerReference.version));
      if (
        !provider ||
        !provider.capabilityTemplates.some(
          (reference) =>
            key(reference.id, reference.version) === key(capability.id, capability.version),
        )
      )
        throw new Error('Provider and capability relationship must be bidirectional');
    }
  }
}

export function createConnectionTemplateRegistry(
  input: {
    providers: readonly unknown[];
    capabilities: readonly unknown[];
  },
  handlerBindings: ReviewedHandlerBindings = reviewedHandlerBindings,
) {
  const { compilers, probes, executors } = handlerBindings;
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
  for (const provider of providers) {
    requireSymbolicHandler(provider.policyCompiler, compilers, 'policy compiler');
    requireSymbolicHandler(provider.probe, probes, 'probe');
  }
  for (const capability of capabilities) {
    requireSymbolicHandler(capability.executor, executors, 'capability executor');
  }
  for (const provider of providers) {
    requireBoundSymbolicHandler(provider.policyCompiler, compilers, 'policy compiler', provider);
    requireBoundSymbolicHandler(provider.probe, probes, 'probe', provider);
  }
  for (const capability of capabilities)
    requireBoundSymbolicHandler(capability.executor, executors, 'capability executor', capability);
  validateVersionedTemplateRelationships(providers, capabilities);

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
      return requireBoundSymbolicHandler(
        template.policyCompiler,
        compilers,
        'policy compiler',
        template,
      )(template, Object.freeze({ ...compileInput.fields }));
    },
    probeFor: (id: string, version: number) => {
      const template = providerByKey.get(key(id, version));
      if (!template) throw new Error('Unknown provider template version');
      return requireBoundSymbolicHandler(template.probe, probes, 'probe', template)(template);
    },
    executorFor: (id: string, version: number) => {
      const template = capabilityByKey.get(key(id, version));
      if (!template) throw new Error('Unknown capability template version');
      return requireBoundSymbolicHandler(
        template.executor,
        executors,
        'capability executor',
        template,
      )(template);
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
        description: 'A one-shot Jira API token paired with the Jira email over HTTP Basic.',
        style: 'basic',
        secret: true,
        required: true,
      },
    ],
    connectionFields: [
      {
        key: 'email',
        label: 'Jira email',
        description: 'The HTTP Basic username paired with the one-shot Jira API token.',
        kind: 'email',
        required: true,
      },
    ],
    policyCompiler: 'jira-readonly-v1',
    probe: 'jira-readonly-v1',
    capabilityTemplates: [],
    guidance: {
      body: 'Use a scoped token with Jira read permission.',
      href: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
      linkLabel: 'Atlassian token and scope guidance',
    },
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
    capabilityTemplates: [{ id: 'github.publish-pr', version: 1 }],
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
        description:
          'Exact public HTTPS origin without a port; the reviewed port is selected separately.',
        kind: 'url',
        required: true,
      },
      {
        key: 'port',
        label: 'HTTPS port',
        description: 'Only the administrator-reviewed TLS ports are available.',
        kind: 'enum-list',
        required: true,
        choices: ['443', '8443'],
      },
      {
        key: 'protocol',
        label: 'Inspection protocol',
        description:
          'REST permits read methods; GraphQL permits only query inspection at /graphql.',
        kind: 'enum-list',
        required: true,
        choices: ['rest', 'graphql'],
      },
      {
        key: 'methods',
        label: 'Read methods',
        description: 'GET, HEAD, and OPTIONS are available for REST; GraphQL uses GRAPHQL_QUERY.',
        kind: 'enum-list',
        required: true,
        choices: ['GET', 'HEAD', 'OPTIONS', 'GRAPHQL_QUERY'],
      },
      {
        key: 'paths',
        label: 'Allowed paths',
        description: 'Exact absolute paths, with an optional terminal `/**` wildcard only.',
        kind: 'string-list',
        required: true,
      },
      {
        key: 'credentialStyle',
        label: 'Credential style',
        description: 'A one-shot token can be compiled only as a reviewed bearer or API token.',
        kind: 'enum-list',
        required: true,
        choices: ['bearer-token', 'api-token'],
      },
      {
        key: 'credentialLocation',
        label: 'Credential location',
        description: 'The token is sent only in the selected reviewed header or query position.',
        kind: 'enum-list',
        required: true,
        choices: ['header', 'query'],
      },
      {
        key: 'credentialName',
        label: 'Credential mapping',
        description: 'Select a reviewed mapping compatible with the selected credential location.',
        kind: 'enum-list',
        required: true,
        choices: ['authorization', 'x-api-key', 'api_key', 'access_token'],
      },
      {
        key: 'binaries',
        label: 'Approved sandbox binaries',
        description: 'Only administrator-catalog binaries are compiled into the provider policy.',
        kind: 'enum-list',
        required: true,
        choices: ['curl', 'jq', 'python3'],
      },
      {
        key: 'attachmentMode',
        label: 'Attachment mode',
        description:
          'Automatic attaches to eligible new conversations; on-demand requires an explicit grant.',
        kind: 'enum-list',
        required: true,
        choices: ['automatic', 'on-demand'],
      },
    ],
    policyCompiler: 'custom-rest-readonly-v1',
    probe: 'custom-rest-readonly-v1',
    capabilityTemplates: [],
  },
];
const capabilities: readonly CapabilityTemplate[] = [
  {
    id: 'github.publish-pr',
    version: 1,
    label: 'Publish pull request',
    description:
      'Publish already-committed work to an approved feature branch after explicit approval.',
    connectionTemplates: [{ id: 'github-readonly', version: 1 }],
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 128 },
        repositoryPath: { type: 'string', minLength: 1, maxLength: 256 },
        baseBranch: { type: 'string', minLength: 1, maxLength: 128 },
        title: { type: 'string', minLength: 1, maxLength: 128 },
        body: { type: 'string', maxLength: 512 },
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

const identityProbe: Probe = () => ({ kind: 'identity-and-scope' });
const approvalRequiredExecutor: CapabilityExecutor = () => ({ kind: 'approval-required' });
// These are intentionally independent snapshots. Updating a manifest without
// introducing a new reviewed template version leaves its old handler unusable.
const reviewedProviderContracts = Object.freeze({
  'jira-readonly@1': providerHandlerContract({
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
        description: 'A one-shot Jira API token paired with the Jira email over HTTP Basic.',
        style: 'basic',
        secret: true,
        required: true,
      },
    ],
    connectionFields: [
      {
        key: 'email',
        label: 'Jira email',
        description: 'The HTTP Basic username paired with the one-shot Jira API token.',
        kind: 'email',
        required: true,
      },
    ],
    capabilityTemplates: [],
    guidance: {
      body: 'Use a scoped token with Jira read permission.',
      href: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
      linkLabel: 'Atlassian token and scope guidance',
    },
  }),
  'github-readonly@1': providerHandlerContract({
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
    capabilityTemplates: [{ id: 'github.publish-pr', version: 1 }],
  }),
  'custom-rest-readonly@1': providerHandlerContract({
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
        description: 'Exact absolute paths, with an optional terminal `/**` wildcard only.',
        kind: 'string-list',
        required: true,
      },
    ],
    capabilityTemplates: [],
  }),
});
const reviewedCapabilityContracts = Object.freeze({
  'github.publish-pr@1': capabilityHandlerContract({
    id: 'github.publish-pr',
    version: 1,
    label: 'Publish pull request',
    description:
      'Publish already-committed work to an approved feature branch after explicit approval.',
    connectionTemplates: [{ id: 'github-readonly', version: 1 }],
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 128 },
        repositoryPath: { type: 'string', minLength: 1, maxLength: 256 },
        baseBranch: { type: 'string', minLength: 1, maxLength: 128 },
        title: { type: 'string', minLength: 1, maxLength: 128 },
        body: { type: 'string', maxLength: 512 },
        draft: { type: 'boolean' },
      },
      required: ['connectionId', 'repositoryPath', 'baseBranch', 'title', 'body', 'draft'],
      additionalProperties: false,
    },
    approval: 'always',
    idempotency: 'required',
  }),
});

function compilerGoldenOutput(
  fields: Readonly<Record<string, string | readonly string[]>>,
): (template: ProviderTemplate | CapabilityTemplate, handler: PolicyCompiler) => unknown {
  return (template, handler) =>
    handler(
      template as ProviderTemplate,
      Object.freeze(
        Object.fromEntries(
          Object.entries(fields).map(([name, value]) => [
            name,
            Array.isArray(value) ? Object.freeze([...value]) : value,
          ]),
        ),
      ) as Record<string, string | string[]>,
    );
}

// These non-secret fixtures exercise every emitted endpoint/rule shape. The
// hash binds their exact effective policy to the implementation revision; a
// handler change requires an intentional reviewed revision/fingerprint update.
const jiraCompilerGoldenOutput = compilerGoldenOutput({ email: 'reviewer@example.com' });
const githubCompilerGoldenOutput = compilerGoldenOutput({
  allowedRepositories: ['Acme/Widget', 'example/other'],
  allowedBaseBranches: ['main', 'release/v1'],
});
const customRestCompilerGoldenOutput = compilerGoldenOutput({
  endpoint: 'https://api.openai.com',
  methods: ['HEAD', 'GET'],
  paths: ['/', '/v1/**'],
});
const probeGoldenOutput = (template: ProviderTemplate | CapabilityTemplate, handler: Probe) =>
  handler(template as ProviderTemplate);
const executorGoldenOutput = (
  template: ProviderTemplate | CapabilityTemplate,
  handler: CapabilityExecutor,
) => handler(template as CapabilityTemplate);

const compilers: Readonly<Record<string, BoundHandler<PolicyCompiler>>> = nullPrototypeHandlers({
  'jira-readonly-v1': bindHandler(
    'jira-readonly@1',
    reviewedProviderContracts['jira-readonly@1'],
    reviewedHandlerImplementationRevision,
    '46edc4d7e2a28a124e3f399073d251c2db657e000a8697c0d112c718ff2e75ed',
    jiraCompilerGoldenOutput,
    compileJiraReadonly,
  ),
  'github-readonly-v1': bindHandler(
    'github-readonly@1',
    reviewedProviderContracts['github-readonly@1'],
    reviewedHandlerImplementationRevision,
    '067c6087d3edb03c295f0e9ffab490f40d61d2b0ea8286a9e79ab4799c4fb4a2',
    githubCompilerGoldenOutput,
    compileGithubReadonly,
  ),
  'custom-rest-readonly-v1': bindHandler(
    'custom-rest-readonly@1',
    reviewedProviderContracts['custom-rest-readonly@1'],
    reviewedHandlerImplementationRevision,
    '8c3824d0fb89e7cafa1842a19db3d66061f002d4392a7b7305c1cea0bda48df8',
    customRestCompilerGoldenOutput,
    compileCustomRestReadonly,
  ),
});
const probes: Readonly<Record<string, BoundHandler<Probe>>> = nullPrototypeHandlers({
  'jira-readonly-v1': bindHandler(
    'jira-readonly@1',
    reviewedProviderContracts['jira-readonly@1'],
    reviewedHandlerImplementationRevision,
    '65430809a0a0048fded453f273186e0c5d66c8b1c964459611a070d5a1654f1f',
    probeGoldenOutput,
    identityProbe,
  ),
  'github-readonly-v1': bindHandler(
    'github-readonly@1',
    reviewedProviderContracts['github-readonly@1'],
    reviewedHandlerImplementationRevision,
    '65430809a0a0048fded453f273186e0c5d66c8b1c964459611a070d5a1654f1f',
    probeGoldenOutput,
    identityProbe,
  ),
  'custom-rest-readonly-v1': bindHandler(
    'custom-rest-readonly@1',
    reviewedProviderContracts['custom-rest-readonly@1'],
    reviewedHandlerImplementationRevision,
    '65430809a0a0048fded453f273186e0c5d66c8b1c964459611a070d5a1654f1f',
    probeGoldenOutput,
    identityProbe,
  ),
});
const executors: Readonly<Record<string, BoundHandler<CapabilityExecutor>>> = nullPrototypeHandlers(
  {
    'github-publish-pr-v1': bindHandler(
      'github.publish-pr@1',
      reviewedCapabilityContracts['github.publish-pr@1'],
      reviewedHandlerImplementationRevision,
      '41d28fe0d516c0f3f22c21871f1a7ac32022d8a16d178adacfc33325b1cdcf80',
      executorGoldenOutput,
      approvalRequiredExecutor,
    ),
  },
);

export const reviewedHandlerBindings: ReviewedHandlerBindings = Object.freeze({
  compilers,
  probes,
  executors,
});

export const connectionTemplateRegistry = createConnectionTemplateRegistry({
  providers,
  capabilities,
});
