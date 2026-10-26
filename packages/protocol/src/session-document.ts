import { z } from 'zod';

export const MAX_SESSION_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const SessionDocumentSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  sessionId: z.string().min(1),
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(200),
  revision: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(MAX_SESSION_DOCUMENT_BYTES),
  sourceKey: z.string(),
  sourcePath: z.string().nullable(),
  createdAt: z.number().int(),
});
export type SessionDocument = z.infer<typeof SessionDocumentSchema>;
export interface SessionDocumentWrite {
  requestId: string;
  intent: string;
  title: string;
  filename: string;
  sourceKey: string;
  sourcePath: string | null;
  bytes: Buffer;
}
