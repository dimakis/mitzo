import { apiFetch } from './api-fetch';
import type {
  ConnectionAuditEntry,
  ConnectionCapabilityGrant,
  ConnectionsCatalog,
  ConnectionTemplateCatalog,
  ManagedConnection,
  GoogleWorkspaceHealth,
  OpenAIKeyHealth,
  EnrolledOpenAIAccount,
} from '../types/connections';

type Reauthorization = { csrf: string; expiresAt: number };

export class ConnectionCreationFailure extends Error {
  constructor(
    message: string,
    readonly connectionId: string | null,
    readonly retrySetup: boolean,
    readonly authorizationRequired = false,
  ) {
    super(message);
    this.name = 'ConnectionCreationFailure';
  }
}

async function bodyOrError<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => ({}));
  const error =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'Request failed';
  if (!response.ok) throw new Error(error);
  return body as T;
}
function json(method: string, body: unknown, csrf?: string): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(body),
  };
}
export async function getConnections(): Promise<ConnectionsCatalog> {
  return bodyOrError<ConnectionsCatalog>(await apiFetch('/api/connections'));
}
export async function getOpenAIAccounts(): Promise<{
  enabled: boolean;
  accounts: EnrolledOpenAIAccount[];
}> {
  return bodyOrError(await apiFetch('/api/connections/openai-accounts'));
}
export async function enrollOpenAIAccount(input: {
  csrf: string;
  requestId: string;
  label: string;
  projectLabel: string;
  apiKey: string;
  billingConfirmed: true;
}): Promise<EnrolledOpenAIAccount> {
  const result = await bodyOrError<{ account: EnrolledOpenAIAccount }>(
    await apiFetch('/api/connections/openai-accounts', json('POST', input, input.csrf)),
  );
  return result.account;
}
export async function getOpenAIKeyStatus(): Promise<OpenAIKeyHealth[]> {
  return (
    await bodyOrError<{ accounts: OpenAIKeyHealth[] }>(
      await apiFetch('/api/connections/openai-keys'),
    )
  ).accounts;
}
type OpenAIKeySelection = {
  accountId: string;
  revision: string;
  sameProject: boolean;
  csrf: string;
};
export async function replaceOpenAIKey(
  input: OpenAIKeySelection & { apiKey: string },
): Promise<OpenAIKeyHealth> {
  const { accountId, ...body } = input;
  return bodyOrError(
    await apiFetch(
      `/api/connections/openai-keys/${encodeURIComponent(accountId)}/replace`,
      json('POST', body, input.csrf),
    ),
  );
}
export async function synchronizeOpenAIKey(input: OpenAIKeySelection): Promise<OpenAIKeyHealth> {
  const { accountId, ...body } = input;
  return bodyOrError(
    await apiFetch(
      `/api/connections/openai-keys/${encodeURIComponent(accountId)}/synchronize`,
      json('POST', body, input.csrf),
    ),
  );
}
export async function getGoogleWorkspaceStatus(): Promise<GoogleWorkspaceHealth> {
  return bodyOrError(await apiFetch('/api/connections/google-workspace'));
}
export async function previewGoogleWorkspace(csrf: string): Promise<{ email: string }> {
  return bodyOrError(
    await apiFetch('/api/connections/google-workspace/preview', json('POST', { csrf })),
  );
}
export async function reconnectGoogleWorkspace(
  csrf: string,
  email: string,
): Promise<GoogleWorkspaceHealth> {
  return bodyOrError(
    await apiFetch('/api/connections/google-workspace/reconnect', json('POST', { csrf, email })),
  );
}
export async function refreshGoogleWorkspace(csrf: string): Promise<GoogleWorkspaceHealth> {
  return bodyOrError(
    await apiFetch('/api/connections/google-workspace/refresh', json('POST', { csrf })),
  );
}
export async function getConnectionTemplates(): Promise<ConnectionTemplateCatalog> {
  return bodyOrError<ConnectionTemplateCatalog>(await apiFetch('/api/connections/templates'));
}
export async function reauthorize(passphrase: string): Promise<Reauthorization> {
  return bodyOrError<Reauthorization>(
    await apiFetch('/api/connections/reauthorize', json('POST', { passphrase })),
  );
}
export async function createConnection(input: {
  templateId: string;
  templateVersion: number;
  label: string;
  fields: Record<string, string | string[]>;
  credentials: Record<string, string>;
  accountIds: string[];
  csrf: string;
}): Promise<ManagedConnection> {
  const { csrf, ...body } = input;
  let response: Response;
  try {
    response = await apiFetch('/api/connections', json('POST', body, csrf));
  } catch {
    throw new ConnectionCreationFailure(
      'Could not confirm connection setup. Check Connections before adding it again.',
      null,
      false,
    );
  }
  const decoded: unknown = await response.json().catch(() => null);
  const result =
    decoded && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : null;
  if (!response.ok) {
    const message = typeof result?.error === 'string' ? result.error : 'Connection setup failed';
    const saved =
      response.status === 422 &&
      typeof result?.savedConnectionId === 'string' &&
      result.savedConnectionId.length
        ? result.savedConnectionId
        : null;
    const retrySetup =
      [400, 401, 403].includes(response.status) ||
      (response.status === 422 && result?.savedConnectionId === null);
    throw new ConnectionCreationFailure(
      message,
      saved,
      retrySetup,
      [401, 403].includes(response.status),
    );
  }
  const value = result?.connection;
  const connection = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (
    !connection ||
    typeof connection.id !== 'string' ||
    !connection.id ||
    typeof connection.label !== 'string' ||
    typeof connection.status !== 'string' ||
    !Array.isArray(connection.desiredAccountIds)
  ) {
    throw new ConnectionCreationFailure(
      'Could not confirm connection setup. Check Connections before adding it again.',
      null,
      false,
    );
  }
  return connection as unknown as ManagedConnection;
}
export async function retryConnection(input: {
  id: string;
  revision: number;
  credentials: Record<string, string>;
  csrf: string;
}): Promise<ManagedConnection> {
  const { id, ...body } = input;
  return (
    await bodyOrError<{ connection: ManagedConnection }>(
      await apiFetch(
        `/api/connections/${encodeURIComponent(id)}/retry`,
        json('POST', body, input.csrf),
      ),
    )
  ).connection;
}
export async function updateAssignments(input: {
  id: string;
  revision: number;
  accountIds: string[];
  csrf: string;
}): Promise<ManagedConnection> {
  const { id, ...body } = input;
  return (
    await bodyOrError<{ connection: ManagedConnection }>(
      await apiFetch(
        `/api/connections/${encodeURIComponent(id)}/assignments`,
        json('PUT', body, input.csrf),
      ),
    )
  ).connection;
}
export async function testConnection(input: {
  id: string;
  revision: number;
  csrf: string;
}): Promise<ManagedConnection> {
  const { id, ...body } = input;
  return (
    await bodyOrError<{ connection: ManagedConnection }>(
      await apiFetch(
        `/api/connections/${encodeURIComponent(id)}/test`,
        json('POST', body, input.csrf),
      ),
    )
  ).connection;
}
export async function rotateConnection(input: {
  id: string;
  revision: number;
  credentials: Record<string, string>;
  csrf: string;
}): Promise<ManagedConnection> {
  const { id, ...body } = input;
  return (
    await bodyOrError<{ connection: ManagedConnection }>(
      await apiFetch(
        `/api/connections/${encodeURIComponent(id)}/rotate`,
        json('POST', body, input.csrf),
      ),
    )
  ).connection;
}
export async function revokeConnection(input: {
  id: string;
  revision: number;
  csrf: string;
}): Promise<ManagedConnection> {
  const { id, ...body } = input;
  return (
    await bodyOrError<{ connection: ManagedConnection }>(
      await apiFetch(
        `/api/connections/${encodeURIComponent(id)}/revoke`,
        json('POST', body, input.csrf),
      ),
    )
  ).connection;
}
export async function deleteConnection(input: {
  id: string;
  revision: number;
  csrf: string;
}): Promise<void> {
  const { id, ...body } = input;
  await bodyOrError(
    await apiFetch(`/api/connections/${encodeURIComponent(id)}`, json('DELETE', body, input.csrf)),
  );
}
export async function getConnectionAudit(id: string): Promise<ConnectionAuditEntry[]> {
  return (
    await bodyOrError<{ audit: ConnectionAuditEntry[] }>(
      await apiFetch(`/api/connections/${encodeURIComponent(id)}/audit`),
    )
  ).audit;
}
export async function getConnectionCapabilityGrants(
  id: string,
): Promise<ConnectionCapabilityGrant[]> {
  return (
    await bodyOrError<{ grants: ConnectionCapabilityGrant[] }>(
      await apiFetch(`/api/connections/${encodeURIComponent(id)}/capabilities`),
    )
  ).grants;
}
export async function setConnectionCapabilityGrant(input: {
  id: string;
  revision: number;
  capabilityId: string;
  capabilityVersion: number;
  accountIds: string[];
  status: 'active' | 'revoked';
  csrf: string;
}): Promise<ConnectionCapabilityGrant> {
  const { id, ...body } = input;
  return (
    await bodyOrError<{ grant: ConnectionCapabilityGrant }>(
      await apiFetch(
        `/api/connections/${encodeURIComponent(id)}/capabilities`,
        json('PUT', body, input.csrf),
      ),
    )
  ).grant;
}
