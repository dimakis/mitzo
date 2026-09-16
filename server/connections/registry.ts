import {
  CAPABILITY_TEMPLATES,
  PROVIDER_TEMPLATES,
  type CapabilityTemplate,
  type CredentialField,
  type JsonSchema,
  type ProviderTemplate,
  type PublicCapabilityTemplate,
  type PublicProviderTemplate,
} from './types.js';
import {
  compileCustomRestReadonly,
  compileGithubReadonly,
  compileJiraReadonly,
  type CompiledConnectionPolicy,
  type PolicyCompiler,
} from './policy-compiler.js';

export type Probe = (input: Readonly<Record<string, unknown>>) => Promise<{ identity: string }>;
export type CapabilityExecutor = (input: Readonly<Record<string, unknown>>) => Promise<unknown>;

export interface RegistryImplementations {
  compilers?: Readonly<Record<string, PolicyCompiler>>;
  probes?: Readonly<Record<string, Probe>>;
  executors?: Readonly<Record<string, CapabilityExecutor>>;
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*-v[1-9][0-9]*$/;
const SAFE_TEMPLATE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;
const SAFE_FIELD_ID = /^[a-z][A-Za-z0-9]{0,63}$/;
const MAX_DESCRIPTION = 2_000;

const CODE_OWNED_IMPLEMENTATIONS: Required<RegistryImplementations> = {
  compilers: {
    'jira-readonly-v1': compileJiraReadonly,
    'github-readonly-v1': compileGithubReadonly,
    'custom-rest-readonly-v1': compileCustomRestReadonly,
  },
  probes: {
    'jira-readonly-v1': async () => ({ identity: 'unimplemented-phase-0' }),
    'github-readonly-v1': async () => ({ identity: 'unimplemented-phase-0' }),
    'custom-rest-readonly-v1': async () => ({ identity: 'unimplemented-phase-0' }),
  },
  executors: {
    'github-publish-pr-v1': async () => {
      throw new Error('Capability execution is not implemented until Phase 3');
    },
  },
};

function invalid(kind: string): never {
  throw new Error(`Invalid ${kind} template`);
}

function assertPlainRecord(value: unknown, kind: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid(kind);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  kind: string,
) {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key)))
    invalid(kind);
}

function nonEmptyString(value: unknown, kind: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) invalid(kind);
}

function templateId(value: unknown, kind: string): asserts value is string {
  nonEmptyString(value, kind, 128);
  if (!SAFE_TEMPLATE_ID.test(value)) invalid(kind);
}

function fieldId(value: unknown, kind: string): asserts value is string {
  nonEmptyString(value, kind, 64);
  if (!SAFE_FIELD_ID.test(value)) invalid(kind);
}

function version(value: unknown, kind: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(kind);
}

function implementationIdentifier(value: unknown, kind: string): asserts value is string {
  nonEmptyString(value, kind, 128);
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`Unsafe ${kind} identifier`);
}

function validateCredentialField(value: unknown) {
  assertPlainRecord(value, 'credential field');
  assertExactKeys(value, ['id', 'label', 'description', 'kind', 'required'], 'credential field');
  fieldId(value.id, 'credential field');
  nonEmptyString(value.label, 'credential field');
  nonEmptyString(value.description, 'credential field', MAX_DESCRIPTION);
  if (value.kind !== 'token' || typeof value.required !== 'boolean') invalid('credential field');
}

function validateConnectionField(value: unknown) {
  assertPlainRecord(value, 'connection field');
  const allowed = ['id', 'label', 'description', 'kind', 'required', 'options'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('connection field');
  fieldId(value.id, 'connection field');
  nonEmptyString(value.label, 'connection field');
  nonEmptyString(value.description, 'connection field', MAX_DESCRIPTION);
  if (!['text', 'email', 'url', 'select', 'string-list'].includes(value.kind as string))
    invalid('connection field');
  if (typeof value.required !== 'boolean') invalid('connection field');
  if (value.options !== undefined) {
    if (
      !Array.isArray(value.options) ||
      value.options.length === 0 ||
      value.options.length > 50 ||
      value.options.some(
        (option) => typeof option !== 'string' || option.length === 0 || option.length > 128,
      )
    )
      invalid('connection field');
  }
  if (value.kind === 'select' && value.options === undefined) invalid('connection field');
  if (value.kind !== 'select' && value.options !== undefined) invalid('connection field');
}

function validateJsonSchema(value: unknown) {
  assertPlainRecord(value, 'capability');
  assertExactKeys(value, ['type', 'properties', 'required', 'additionalProperties'], 'capability');
  if (
    value.type !== 'object' ||
    value.additionalProperties !== false ||
    !Array.isArray(value.required)
  )
    invalid('capability');
  assertPlainRecord(value.properties, 'capability');
  const propertyNames = Object.keys(value.properties);
  if (propertyNames.length === 0 || propertyNames.length > 30) invalid('capability');
  for (const name of propertyNames) {
    fieldId(name, 'capability');
    const property = value.properties[name];
    assertPlainRecord(property, 'capability');
    if (
      Object.keys(property).some(
        (key) => !['type', 'description', 'maxLength', 'pattern'].includes(key),
      )
    )
      invalid('capability');
    if (property.type !== 'string' && property.type !== 'boolean') invalid('capability');
    if (property.description !== undefined)
      nonEmptyString(property.description, 'capability', MAX_DESCRIPTION);
    if (
      property.maxLength !== undefined &&
      (!Number.isSafeInteger(property.maxLength) ||
        (property.maxLength as number) < 1 ||
        (property.maxLength as number) > 65_536)
    )
      invalid('capability');
    if (property.pattern !== undefined) {
      nonEmptyString(property.pattern, 'capability', 512);
      try {
        new RegExp(property.pattern);
      } catch {
        invalid('capability');
      }
    }
  }
  if (
    value.required.length !== propertyNames.length ||
    value.required.some((name) => typeof name !== 'string' || !propertyNames.includes(name)) ||
    new Set(value.required).size !== value.required.length
  )
    invalid('capability');
}

function validateProviderTemplate(value: unknown): asserts value is ProviderTemplate {
  assertPlainRecord(value, 'provider');
  assertExactKeys(
    value,
    [
      'id',
      'version',
      'label',
      'category',
      'description',
      'risk',
      'operatorOnly',
      'credentialFields',
      'connectionFields',
      'policyCompiler',
      'probe',
      'capabilityIds',
    ],
    'provider',
  );
  templateId(value.id, 'provider');
  version(value.version, 'provider');
  nonEmptyString(value.label, 'provider');
  nonEmptyString(value.description, 'provider', MAX_DESCRIPTION);
  if (!['source-control', 'productivity', 'data', 'custom-api'].includes(value.category as string))
    invalid('provider');
  if (!['read-only', 'bounded-write', 'operator-defined'].includes(value.risk as string))
    invalid('provider');
  if (typeof value.operatorOnly !== 'boolean') invalid('provider');
  if (
    !Array.isArray(value.credentialFields) ||
    !Array.isArray(value.connectionFields) ||
    !Array.isArray(value.capabilityIds)
  )
    invalid('provider');
  if (
    value.credentialFields.length > 10 ||
    value.connectionFields.length > 20 ||
    value.capabilityIds.length > 20
  )
    invalid('provider');
  value.credentialFields.forEach(validateCredentialField);
  value.connectionFields.forEach(validateConnectionField);
  const fieldIds = [...value.credentialFields, ...value.connectionFields].map((field) => field.id);
  if (new Set(fieldIds).size !== fieldIds.length) invalid('provider');
  value.capabilityIds.forEach((capabilityId) => templateId(capabilityId, 'provider'));
  if (new Set(value.capabilityIds).size !== value.capabilityIds.length) invalid('provider');
  implementationIdentifier(value.policyCompiler, 'compiler');
  implementationIdentifier(value.probe, 'probe');
}

function validateCapabilityTemplate(value: unknown): asserts value is CapabilityTemplate {
  assertPlainRecord(value, 'capability');
  assertExactKeys(
    value,
    [
      'id',
      'version',
      'label',
      'description',
      'connectionTemplateIds',
      'inputSchema',
      'executor',
      'approval',
      'idempotency',
    ],
    'capability',
  );
  templateId(value.id, 'capability');
  version(value.version, 'capability');
  nonEmptyString(value.label, 'capability');
  nonEmptyString(value.description, 'capability', MAX_DESCRIPTION);
  if (
    !Array.isArray(value.connectionTemplateIds) ||
    value.connectionTemplateIds.length === 0 ||
    value.connectionTemplateIds.length > 20
  )
    invalid('capability');
  value.connectionTemplateIds.forEach((id) => templateId(id, 'capability'));
  if (new Set(value.connectionTemplateIds).size !== value.connectionTemplateIds.length)
    invalid('capability');
  validateJsonSchema(value.inputSchema);
  implementationIdentifier(value.executor, 'executor');
  if (value.approval !== 'always' && value.approval !== 'explicit-intent') invalid('capability');
  if (value.idempotency !== 'required') invalid('capability');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function publicProvider(template: ProviderTemplate): PublicProviderTemplate {
  const credentials: readonly CredentialField[] = template.credentialFields.map((field) => ({
    id: field.id,
    label: field.label,
    description: field.description,
    kind: field.kind,
    required: field.required,
  }));
  return deepFreeze({
    id: template.id,
    version: template.version,
    label: template.label,
    category: template.category,
    description: template.description,
    risk: template.risk,
    operatorOnly: template.operatorOnly,
    credentialFields: credentials,
    connectionFields: template.connectionFields.map((field) => ({
      ...field,
      options: field.options ? [...field.options] : undefined,
    })),
    capabilityIds: [...template.capabilityIds],
  });
}

function publicCapability(template: CapabilityTemplate): PublicCapabilityTemplate {
  return deepFreeze({
    id: template.id,
    version: template.version,
    label: template.label,
    description: template.description,
    connectionTemplateIds: [...template.connectionTemplateIds],
    inputSchema: structuredClone(template.inputSchema) as JsonSchema,
    approval: template.approval,
    idempotency: template.idempotency,
  });
}

export class TemplateRegistry {
  private readonly providers = new Map<string, ProviderTemplate>();
  private readonly capabilities = new Map<string, CapabilityTemplate>();
  private readonly implementations: Required<RegistryImplementations>;

  constructor(
    providers: readonly ProviderTemplate[],
    capabilities: readonly CapabilityTemplate[],
    implementations: RegistryImplementations,
  ) {
    this.implementations = {
      compilers: { ...CODE_OWNED_IMPLEMENTATIONS.compilers, ...implementations.compilers },
      probes: { ...CODE_OWNED_IMPLEMENTATIONS.probes, ...implementations.probes },
      executors: { ...CODE_OWNED_IMPLEMENTATIONS.executors, ...implementations.executors },
    };
    for (const provider of providers) {
      validateProviderTemplate(provider);
      const key = `${provider.id}@${provider.version}`;
      if (this.providers.has(key)) throw new Error(`Duplicate provider template ${key}`);
      if (typeof this.implementations.compilers[provider.policyCompiler] !== 'function')
        throw new Error(`Provider compiler is not registered: ${provider.policyCompiler}`);
      if (typeof this.implementations.probes[provider.probe] !== 'function')
        throw new Error(`Provider probe is not registered: ${provider.probe}`);
      this.providers.set(key, deepFreeze(structuredClone(provider)));
    }
    for (const capability of capabilities) {
      validateCapabilityTemplate(capability);
      const key = `${capability.id}@${capability.version}`;
      if (this.capabilities.has(key)) throw new Error(`Duplicate capability template ${key}`);
      if (typeof this.implementations.executors[capability.executor] !== 'function')
        throw new Error(`Capability executor is not registered: ${capability.executor}`);
      this.capabilities.set(key, deepFreeze(structuredClone(capability)));
    }
    for (const provider of this.providers.values()) {
      for (const capabilityId of provider.capabilityIds) {
        const matching = [...this.capabilities.values()].filter(
          (capability) =>
            capability.id === capabilityId &&
            capability.connectionTemplateIds.includes(provider.id),
        );
        if (matching.length === 0)
          throw new Error(
            `Provider capability is not reviewed for ${provider.id}: ${capabilityId}`,
          );
      }
    }
    for (const capability of this.capabilities.values()) {
      for (const providerId of capability.connectionTemplateIds) {
        const exposed = [...this.providers.values()].some(
          (provider) =>
            provider.id === providerId && provider.capabilityIds.includes(capability.id),
        );
        if (!exposed)
          throw new Error(
            `Capability ${capability.id} does not expose a compatible provider ${providerId}`,
          );
      }
    }
  }

  listProviders(): readonly PublicProviderTemplate[] {
    return [...this.providers.values()]
      .map(publicProvider)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  listCapabilities(): readonly PublicCapabilityTemplate[] {
    return [...this.capabilities.values()]
      .map(publicCapability)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  resolveProvider(id: string, version: number): ProviderTemplate | undefined {
    return this.providers.get(`${id}@${version}`);
  }

  resolveCapability(id: string, version: number): CapabilityTemplate | undefined {
    return this.capabilities.get(`${id}@${version}`);
  }

  compilerFor(id: string, version: number): PolicyCompiler | undefined {
    const template = this.resolveProvider(id, version);
    return template ? this.implementations.compilers[template.policyCompiler] : undefined;
  }

  probeFor(id: string, version: number): Probe | undefined {
    const template = this.resolveProvider(id, version);
    return template ? this.implementations.probes[template.probe] : undefined;
  }

  executorFor(id: string, version: number): CapabilityExecutor | undefined {
    const template = this.resolveCapability(id, version);
    return template ? this.implementations.executors[template.executor] : undefined;
  }

  compileProvider(
    id: string,
    version: number,
    fields: Readonly<Record<string, unknown>>,
  ): CompiledConnectionPolicy | undefined {
    const template = this.resolveProvider(id, version);
    return template
      ? this.implementations.compilers[template.policyCompiler](template, fields)
      : undefined;
  }
}

export function createTemplateRegistry(options: {
  providers?: readonly ProviderTemplate[];
  capabilities?: readonly CapabilityTemplate[];
  implementations?: RegistryImplementations;
}): TemplateRegistry {
  return new TemplateRegistry(
    options.providers ?? PROVIDER_TEMPLATES,
    options.capabilities ?? CAPABILITY_TEMPLATES,
    options.implementations ?? {},
  );
}

export const TEMPLATE_REGISTRY = createTemplateRegistry({});
