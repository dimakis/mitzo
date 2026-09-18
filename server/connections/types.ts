/**
 * Phase 0 contracts for reviewed, versioned connection templates. These types
 * are intentionally separate from the legacy connection store: wiring them
 * into routes and persistence is Phase 1 work.
 */

export type ProviderCategory = 'source-control' | 'productivity' | 'data' | 'custom-api';
export type ProviderRisk = 'read-only' | 'bounded-write' | 'operator-defined';
export type FieldKind = 'text' | 'email' | 'url' | 'token' | 'select' | 'string-list';
export type ApprovalRequirement = 'always' | 'explicit-intent';
export type IdempotencyRequirement = 'required';

export interface CredentialField {
  id: string;
  label: string;
  description: string;
  kind: Extract<FieldKind, 'token'>;
  required: boolean;
}

export interface ConnectionField {
  id: string;
  label: string;
  description: string;
  kind: Exclude<FieldKind, 'token'>;
  required: boolean;
  options?: readonly string[];
}

/** A bounded JSON Schema subset adequate for declaring Phase 0 capability inputs. */
export interface JsonSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'boolean';
      description?: string;
      maxLength?: number;
      pattern?: string;
    }
  >;
  required: readonly string[];
  additionalProperties: false;
}

/** Implementation bindings are resolved by the registry, never supplied by clients. */
export interface ProviderTemplate {
  id: string;
  version: number;
  label: string;
  category: ProviderCategory;
  description: string;
  risk: ProviderRisk;
  operatorOnly: boolean;
  credentialFields: readonly CredentialField[];
  connectionFields: readonly ConnectionField[];
  policyCompiler: string;
  probe: string;
  capabilityIds: readonly string[];
}

export interface CapabilityTemplate {
  id: string;
  version: number;
  label: string;
  description: string;
  connectionTemplateIds: readonly string[];
  inputSchema: JsonSchema;
  executor: string;
  approval: ApprovalRequirement;
  idempotency: IdempotencyRequirement;
}

/** The only template shape permitted to leave the controller. */
export interface PublicProviderTemplate {
  id: string;
  version: number;
  label: string;
  category: ProviderCategory;
  description: string;
  risk: ProviderRisk;
  operatorOnly: boolean;
  credentialFields: readonly CredentialField[];
  connectionFields: readonly ConnectionField[];
  capabilityIds: readonly string[];
}

export interface PublicCapabilityTemplate {
  id: string;
  version: number;
  label: string;
  description: string;
  connectionTemplateIds: readonly string[];
  inputSchema: JsonSchema;
  approval: ApprovalRequirement;
  idempotency: IdempotencyRequirement;
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'jira-readonly',
    version: 1,
    label: 'Jira',
    category: 'data',
    description: 'Read approved Jira issues and metadata through the reviewed Atlassian endpoint.',
    risk: 'read-only',
    operatorOnly: false,
    credentialFields: [
      {
        id: 'apiToken',
        label: 'API token',
        description: 'A Jira API token; it is sent one time to the gateway.',
        kind: 'token',
        required: true,
      },
    ],
    connectionFields: [
      {
        id: 'email',
        label: 'Email address',
        description: 'The Jira account associated with the API token.',
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
    description: 'Read approved GitHub repositories through the built-in read-only profile.',
    risk: 'read-only',
    operatorOnly: false,
    credentialFields: [
      {
        id: 'token',
        label: 'Fine-grained access token',
        description: 'A read-only GitHub token; it is sent one time to the gateway.',
        kind: 'token',
        required: true,
      },
    ],
    connectionFields: [
      {
        id: 'repositories',
        label: 'Allowed repositories',
        description: 'Repository owner/name pairs this connection may read.',
        kind: 'string-list',
        required: true,
      },
      {
        id: 'baseBranches',
        label: 'Allowed base branches',
        description: 'Branches that a reviewed publish capability may target.',
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
      'Operator-only, HTTPS-only REST access with explicit read-only paths and binaries.',
    risk: 'operator-defined',
    operatorOnly: true,
    credentialFields: [
      {
        id: 'token',
        label: 'API token',
        description: 'A token sent one time to the gateway using the reviewed credential style.',
        kind: 'token',
        required: true,
      },
    ],
    connectionFields: [
      {
        id: 'endpoint',
        label: 'HTTPS endpoint',
        description: 'A public HTTPS origin without credentials or a custom port.',
        kind: 'url',
        required: true,
      },
      {
        id: 'methods',
        label: 'Allowed methods',
        description: 'Only GET, HEAD, and OPTIONS are supported.',
        kind: 'string-list',
        required: true,
      },
      {
        id: 'paths',
        label: 'Allowed paths',
        description: 'Absolute API paths; a trailing /** may match descendants.',
        kind: 'string-list',
        required: true,
      },
      {
        id: 'credentialStyle',
        label: 'Credential style',
        description: 'The reviewed Authorization header style for the token.',
        kind: 'select',
        required: true,
        options: ['bearer', 'basic'],
      },
      {
        id: 'binaries',
        label: 'Allowed binaries',
        description: 'Choose only from the administrator-maintained binary catalog.',
        kind: 'string-list',
        required: true,
      },
    ],
    policyCompiler: 'custom-rest-readonly-v1',
    probe: 'custom-rest-readonly-v1',
    capabilityIds: [],
  },
];

export const CAPABILITY_TEMPLATES: readonly CapabilityTemplate[] = [
  {
    id: 'github.publish-pr',
    version: 1,
    label: 'Publish pull request',
    description: 'Publish committed sandbox work to an approved non-default GitHub branch.',
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
