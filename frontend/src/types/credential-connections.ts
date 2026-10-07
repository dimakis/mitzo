export type ConnectionAuth =
  | { kind: 'bearer' }
  | { kind: 'basic'; username: string }
  | { kind: 'api-key' | 'password'; headerName: string };
export type ConnectionMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface CredentialConnectionInput {
  label: string;
  endpoint: string;
  auth: ConnectionAuth;
  paths: string[];
  methods: ConnectionMethod[];
  allowPrivateNetwork: boolean;
}
export interface CredentialConnection extends CredentialConnectionInput {
  id: string;
  revision: number;
  status: 'active' | 'disabled';
  verifiedAt: number | null;
}
export interface ConnectionSessionAccess {
  sessionId: string;
  revision: number;
}
export type CredentialConnectionEnrollment = { connection: CredentialConnectionInput } & (
  { secret: string } | { existing: { service: string; account: string } }
);

export type ConnectionRun = (action: () => Promise<unknown>, success: string) => Promise<void>;
