/** Nonsecret read model. Actions only navigate to existing owning controls. */
export type AccessResourceKind =
  | 'ai-account'
  | 'managed-connection'
  | 'personal-connection'
  | 'google-workspace'
  | 'legacy-provider';
export interface AccessResource {
  id: string;
  kind: AccessResourceKind;
  section: 'accounts' | 'services';
  owner: string;
  nativeId: string;
  gateway: string | null;
  workspace: string | null;
  label: string;
  provider: string;
  status: string;
  revision: number | null;
  accountIdentity: string | null;
  verification: {
    state: 'verified' | 'stale' | 'unverified' | 'unavailable';
    verifiedAt: number | null;
    reason: string | null;
  };
  access: {
    summary: string;
    desiredAccountIds: string[];
    observedAttachments: null;
    appliesTo: string;
  };
  actions: Array<{ id: string; label: string; href: string }>;
  details: {
    billing?: string;
    models?: Array<{ id: string; label: string }>;
    expiresAt?: number | null;
    endpoint?: string;
  };
}
export interface ConnectionsAccessInventory {
  generatedAt: number;
  resources: AccessResource[];
  sources: Array<{
    id: 'accounts' | 'symposiumAccounts' | 'managed' | 'personal' | 'google' | 'legacy';
    state: 'available' | 'unavailable' | 'not-configured';
    reason: string | null;
  }>;
}
