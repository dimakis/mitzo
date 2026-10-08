import { apiFetch } from './api-fetch';
import type {
  CredentialConnection,
  CredentialConnectionEnrollment,
  ConnectionSessionAccess,
} from '../types/credential-connections';
const base = '/api/credential-connections';
async function request<T>(path: string, method = 'GET', body?: unknown, csrf?: string): Promise<T> {
  const response = await apiFetch(base + path, {
    method,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data && typeof data.error === 'string' ? data.error : 'Connection request failed',
    );
  return data as T;
}
export async function getCredentialConnections() {
  const data = await request<{ connections: CredentialConnection[] }>('');
  if (!data || !Array.isArray(data.connections))
    throw new Error('Apple Keychain connections are not configured.');
  return data.connections;
}
export function reauthorizeKeychain(passphrase: string) {
  return request<{ csrf: string; expiresAt: number }>('/reauthorize', 'POST', { passphrase });
}
export async function createCredentialConnection(
  body: CredentialConnectionEnrollment,
  csrf: string,
) {
  return (await request<{ connection: CredentialConnection }>('', 'POST', body, csrf)).connection;
}
export async function rotateCredentialConnection(
  id: string,
  revision: number,
  secret: string,
  csrf: string,
) {
  return (
    await request<{ connection: CredentialConnection }>(
      `/${encodeURIComponent(id)}/rotate`,
      'POST',
      { revision, secret },
      csrf,
    )
  ).connection;
}
export function testCredentialConnection(id: string, revision: number, path: string, csrf: string) {
  return request(`/${encodeURIComponent(id)}/test`, 'POST', { revision, path }, csrf);
}
export function disableCredentialConnection(id: string, revision: number, csrf: string) {
  return request(`/${encodeURIComponent(id)}/disable`, 'POST', { revision }, csrf);
}
export async function getConnectionSessions(id: string) {
  return (
    await request<{ sessions: ConnectionSessionAccess[] }>(`/${encodeURIComponent(id)}/sessions`)
  ).sessions;
}
export function revokeConnectionSession(
  id: string,
  sessionId: string,
  revision: number,
  csrf: string,
) {
  return request(
    `/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    'DELETE',
    { revision },
    csrf,
  );
}
