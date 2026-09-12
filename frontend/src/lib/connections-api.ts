import { apiFetch } from './api-fetch';
import type {
  ConnectionAuditEntry,
  ConnectionsCatalog,
  ManagedConnection,
} from '../types/connections';

type Reauthorization = { csrf: string; expiresAt: number };

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
export async function reauthorize(passphrase: string): Promise<Reauthorization> {
  return bodyOrError<Reauthorization>(
    await apiFetch('/api/connections/reauthorize', json('POST', { passphrase })),
  );
}
export async function createConnection(input: {
  label: string;
  email: string;
  token: string;
  accountIds: string[];
  csrf: string;
}): Promise<ManagedConnection> {
  const { csrf, ...body } = input;
  return (
    await bodyOrError<{ connection: ManagedConnection }>(
      await apiFetch('/api/connections', json('POST', body, csrf)),
    )
  ).connection;
}
export async function retryConnection(input: {
  id: string;
  revision: number;
  token: string;
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
  token: string;
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
export async function getConnectionAudit(id: string): Promise<ConnectionAuditEntry[]> {
  return (
    await bodyOrError<{ audit: ConnectionAuditEntry[] }>(
      await apiFetch(`/api/connections/${encodeURIComponent(id)}/audit`),
    )
  ).audit;
}
