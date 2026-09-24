export type ConnectionStatus =
  'provisioning' | 'needs_attention' | 'active' | 'rotating' | 'revoking' | 'revoked';

export interface ManagedConnection {
  id: string;
  templateId: string;
  templateVersion: number;
  label: string;
  status: ConnectionStatus;
  revision: number;
  endpoint: string;
  publicConfig: Record<string, string | string[]>;
  desiredAccountIds: string[];
  identity: string | null;
  verifiedAt: number | null;
  errorCode: string | null;
}

export type ProviderRisk = 'read-only' | 'bounded-write' | 'operator-defined';
export type ConnectionFieldKind = 'string' | 'email' | 'url' | 'string-list' | 'enum-list';

export interface ConnectionCredentialField {
  key: string;
  label: string;
  description: string;
  style: 'bearer-token' | 'api-token' | 'basic' | 'oauth2';
  secret: true;
  required: boolean;
}

export interface ConnectionField {
  key: string;
  label: string;
  description: string;
  kind: ConnectionFieldKind;
  required: boolean;
  choices?: string[];
}

export interface ConnectionTemplate {
  id: string;
  version: number;
  label: string;
  category: 'source-control' | 'productivity' | 'data' | 'custom-api';
  description: string;
  risk: ProviderRisk;
  credentialFields: ConnectionCredentialField[];
  connectionFields: ConnectionField[];
  capabilityTemplates: Array<{ id: string; version: number }>;
  /** Set by the server from the active gateway's supported template versions. */
  available: boolean;
  guidance?: { body: string; href: string; linkLabel: string };
}

export interface ConnectionCapability {
  id: string;
  version: number;
  label: string;
  description: string;
  connectionTemplates: Array<{ id: string; version: number }>;
  approval: 'always' | 'explicit-intent';
  idempotency: 'required';
}

export interface ConnectionTemplateCatalog {
  templates: ConnectionTemplate[];
  capabilities: ConnectionCapability[];
}

export interface ConnectionAuditEntry {
  id: string;
  operation: string;
  outcome: string;
  affectedRefs: string[];
  createdAt: number;
}

export interface ConnectionsCatalog {
  connections: ManagedConnection[];
  legacy: Array<{ id: string; label: string; management: string }>;
  eligibleAccounts: string[];
  appliesTo: string;
}
