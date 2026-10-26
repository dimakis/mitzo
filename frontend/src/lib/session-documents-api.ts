import { z } from 'zod';
import { SessionDocumentSchema } from '@mitzo/protocol';
import { apiFetch } from './api-fetch';
import { createBrowserId, sha256Hex } from './browser-crypto';

export const documentPreview = z.object({
  path: z.string(),
  filename: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  content: z.string().nullable(),
});
export const documentCatalog = z.object({
  saved: z.array(SessionDocumentSchema).max(100),
  workspace: z
    .array(
      z.object({ path: z.string(), title: z.string(), evidence: z.enum(['created', 'linked']) }),
    )
    .max(100),
  telos: z
    .array(
      z.object({
        id: z.string().regex(/^[a-f0-9]{32}$/),
        itemId: z.string(),
        title: z.string(),
        filename: z.string(),
        revision: z.number().int().positive(),
        sha256: z.string(),
        size: z.number(),
        url: z.string(),
      }),
    )
    .max(100),
  telosError: z.string().optional(),
  telosHasMore: z.boolean().optional(),
  discoveryLimit: z.number(),
});
export type DocumentCatalog = z.infer<typeof documentCatalog>;
export type DocumentPreview = z.infer<typeof documentPreview>;
export const documentBase = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/documents`;
export async function documentJson(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init);
  const body = await response.json();
  if (!response.ok) throw Error(body.error || 'Document request failed. Retry.');
  return body;
}
export async function keepDocument(sessionId: string, payload: Record<string, unknown>) {
  const key = `mitzo-document-save:${encodeURIComponent(sessionId)}:${sha256Hex(JSON.stringify(payload))}`;
  const requestId = sessionStorage.getItem(key) || createBrowserId();
  sessionStorage.setItem(key, requestId);
  if (sessionStorage.getItem(key) !== requestId)
    throw Error('Save retry could not be recorded. Retry before keeping this document.');
  const body = await documentJson(`${documentBase(sessionId)}/keep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, requestId }),
  });
  const document = SessionDocumentSchema.parse(body.document);
  const source = payload.source as { sha256?: string; kind?: string; path?: string };
  if (
    document.sessionId !== sessionId ||
    document.title !== payload.title ||
    document.sha256 !== source.sha256 ||
    (source.kind === 'file' && document.sourcePath !== source.path)
  )
    throw Error('Document save could not be confirmed. Retry this save.');
  sessionStorage.removeItem(key);
  return document;
}
