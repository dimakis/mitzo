import { apiFetch, AUTH_LOST_EVENT } from './api-fetch';
import type {
  CredentialConnection,
  CredentialConnectionEnrollment,
  ConnectionSessionAccess,
  DashboardAccess,
  ConnectionWebSocketConfig,
} from '../types/credential-connections';
const base = '/api/credential-connections';
type CredentialAuthorization = { csrf: string; expiresAt: number };
let cachedAuthorization: CredentialAuthorization | undefined;
/** Kept only in this document's memory; never credentials, cookies or persistent storage. */
export function getCachedCredentialAuthorization() {
  if (!cachedAuthorization || cachedAuthorization.expiresAt <= Date.now()) {
    cachedAuthorization = undefined;
    return undefined;
  }
  return cachedAuthorization;
}
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, () => {
    cachedAuthorization = undefined;
  });
}

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
  if (response.status === 401 || response.status === 403) cachedAuthorization = undefined;
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
export async function reauthorizeKeychain(passphrase: string) {
  cachedAuthorization = undefined;
  const authorization = await request<CredentialAuthorization>('/reauthorize', 'POST', {
    passphrase,
  });
  cachedAuthorization = authorization;
  return authorization;
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

export async function updateDashboardAccess(
  id: string,
  revision: number,
  access: DashboardAccess,
  csrf: string,
) {
  return (
    await request<{ connection: CredentialConnection }>(
      `/${encodeURIComponent(id)}/dashboard-access`,
      'POST',
      { revision, access },
      csrf,
    )
  ).connection;
}

export async function updateConnectionWebSocket(
  id: string,
  revision: number,
  websocket: ConnectionWebSocketConfig | null,
  csrf: string,
) {
  return (
    await request<{ connection: CredentialConnection }>(
      `/${encodeURIComponent(id)}/websocket`,
      'POST',
      { revision, websocket },
      csrf,
    )
  ).connection;
}

export async function getConnectionSetup(id: string) {
  return (
    await request<{ setup: import('../types/credential-connections').ConnectionSetup }>(
      `/setups/${encodeURIComponent(id)}`,
    )
  ).setup;
}
export async function completeConnectionSetup(
  id: string,
  revision: number,
  secret: string,
  csrf: string,
) {
  return (
    await request<{ setup: import('../types/credential-connections').ConnectionSetup }>(
      `/setups/${encodeURIComponent(id)}/complete`,
      'POST',
      { revision, secret },
      csrf,
    )
  ).setup;
}
export async function cancelConnectionSetup(id: string, revision: number, csrf: string) {
  return (
    await request<{ setup: import('../types/credential-connections').ConnectionSetup }>(
      `/setups/${encodeURIComponent(id)}/cancel`,
      'POST',
      { revision },
      csrf,
    )
  ).setup;
}
