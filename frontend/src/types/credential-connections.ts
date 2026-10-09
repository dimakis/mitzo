export type ConnectionAuth =
  | { kind: 'bearer' }
  | { kind: 'basic'; username: string }
  | { kind: 'api-key' | 'password'; headerName: string };
export type CredentialConnectionTemplate = 'home-assistant' | 'custom';
export type DashboardAccess = 'disabled' | 'read' | 'read-write';
export type ConnectionMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface CredentialConnectionInput {
  label: string;
  endpoint: string;
  auth: ConnectionAuth;
  paths: string[];
  methods: ConnectionMethod[];
  allowPrivateNetwork: boolean;
  homeAssistantDashboards?: DashboardAccess;
  websocket?: ConnectionWebSocketConfig | null;
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

export interface WebSocketMatch {
  field: string;
  equals: string | number | boolean | null;
}
export type WebSocketAuthentication =
  | { kind: 'headers' }
  | {
      kind: 'json';
      message: string;
      credentialField: string;
      challenge?: WebSocketMatch;
      success: WebSocketMatch;
    };
export interface ConnectionWebSocketConfig {
  path: string;
  protocols?: string[];
  authentication: WebSocketAuthentication;
}
export interface WebSocketDraft {
  mode: 'disabled' | 'headers' | 'home-assistant' | 'custom';
  path: string;
  protocols: string;
  authentication: string;
}
