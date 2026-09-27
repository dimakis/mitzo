export interface PublicationCredential {
  id: string;
  label: string;
  revision: number;
}
export interface PublicationSelection {
  connectionId: string;
  connectionRevision: number;
  credentialGeneration: string;
  recordId: string;
  recordHash: string;
  sealId: string;
  sealHash: string;
  repository: string;
}
export interface PublicationPrincipal {
  host: 'github.com';
  numericId: number;
  login: string;
}
export interface PublicationGrant {
  id: string;
  bindingHash: string;
}
