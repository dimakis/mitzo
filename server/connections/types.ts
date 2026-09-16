/**
 * Versioned, reviewed connection contracts.  These types deliberately model
 * templates rather than provisioned connections: credentials are never part
 * of a template or of a compiled policy.
 */

export type ProviderCategory = 'source-control' | 'productivity' | 'data' | 'custom-api';
export type ProviderRisk = 'read-only' | 'bounded-write' | 'operator-defined';
export type CredentialStyle = 'bearer-token' | 'api-token' | 'basic' | 'oauth2';
export type ConnectionFieldKind = 'string' | 'email' | 'url' | 'string-list' | 'enum-list';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CredentialField {
  key: string;
  label: string;
  description: string;
  style: CredentialStyle;
  /** Always true: this is a one-shot browser input, never public configuration. */
  secret: true;
  required: boolean;
}

export interface ConnectionField {
  key: string;
  label: string;
  description: string;
  kind: ConnectionFieldKind;
  required: boolean;
  choices?: readonly string[];
}

export interface ProviderTemplate {
  id: string;
  version: number;
  label: string;
  category: ProviderCategory;
  description: string;
  risk: ProviderRisk;
  credentialFields: readonly CredentialField[];
  connectionFields: readonly ConnectionField[];
  /** Code-owned symbolic key, never a path or command. */
  policyCompiler: string;
  /** Code-owned symbolic key, never a path or command. */
  probe: string;
  capabilityIds: readonly string[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'boolean'; maxLength?: number }>;
  required: readonly string[];
  additionalProperties: false;
}

export interface CapabilityTemplate {
  id: string;
  version: number;
  label: string;
  description: string;
  connectionTemplateIds: readonly string[];
  inputSchema: JsonSchema;
  /** Code-owned symbolic key, never a path or command. */
  executor: string;
  approval: 'always' | 'explicit-intent';
  idempotency: 'required';
}

export interface PublicProviderTemplate {
  id: string;
  version: number;
  label: string;
  category: ProviderCategory;
  description: string;
  risk: ProviderRisk;
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
  approval: 'always' | 'explicit-intent';
  idempotency: 'required';
}

export interface ProviderPolicy {
  templateId: string;
  templateVersion: number;
  /** Each endpoint is inspected and constrained independently. */
  endpoints: readonly {
    host: string;
    port: 443;
    protocol: 'rest' | 'graphql' | 'git';
    tls: 'terminate';
    redirects: 'deny';
    /** Required for custom endpoints before provisioning and on every use. */
    dns?: PublicOnlyPinnedDnsRequirement;
    rules: readonly {
      method: 'GET' | 'HEAD' | 'OPTIONS' | 'GRAPHQL_QUERY' | 'GIT_UPLOAD_PACK';
      path: string;
    }[];
    allowedBinaries: readonly string[];
  }[];
  credentialFieldKeys: readonly string[];
  /** Canonical, validated, non-secret connection fields retained with this template version. */
  publicConfig: Readonly<Record<string, string | readonly string[]>>;
}

/** The Phase 1 gateway adapter must pin public answers at provision time and compare them on every use. */
export interface PublicOnlyPinnedDnsRequirement {
  mode: 'pinned-public-only';
  hostname: string;
  verifyAt: 'provision-and-every-use';
  rejectRebinding: true;
}

export interface PinnedPublicDnsAnswers extends PublicOnlyPinnedDnsRequirement {
  addresses: readonly string[];
}

export interface CompileProviderPolicyInput {
  templateId: string;
  templateVersion: number;
  /** Public configuration only. Credentials belong to the gateway adapter. */
  fields: Record<string, string | string[]>;
}

export type PolicyCompiler = (
  template: ProviderTemplate,
  fields: Readonly<Record<string, string | string[]>>,
) => ProviderPolicy;

/** A probe declaration; invocation is intentionally deferred to Phase 1. */
export type Probe = (template: ProviderTemplate) => { kind: 'identity-and-scope' };

/** An executor declaration; execution is intentionally deferred to Phase 3. */
export type CapabilityExecutor = (template: CapabilityTemplate) => { kind: 'approval-required' };
