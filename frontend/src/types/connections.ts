export type ConnectionStatus =
  'provisioning' | 'needs_attention' | 'active' | 'rotating' | 'revoking' | 'revoked';

export interface ManagedConnection {
  id: string;
  label: string;
  status: ConnectionStatus;
  revision: number;
  endpoint: string;
  desiredAccountIds: string[];
  identity: string | null;
  verifiedAt: number | null;
  errorCode: string | null;
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
  legacy: string[];
  eligibleAccounts: string[];
  appliesTo: string;
}
