import { z } from 'zod';
import type { SymposiumProvenance } from './symposium.js';

/** A reference in its conversation's existing access/retention scope; never copied content. */
export const SessionOutputSourceSchema = z.strictObject({
  messageId: z.string().min(1).max(200),
  blockId: z.string().min(1).max(200),
  messageEndSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SessionOutputRegisterInputSchema = z.strictObject({
  requestId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  source: SessionOutputSourceSchema,
});
export type SessionOutputSource = z.infer<typeof SessionOutputSourceSchema>;
export type SessionOutputRegisterInput = z.infer<typeof SessionOutputRegisterInputSchema>;

export const OutputContributorBindingSchema = z.strictObject({
  parentSessionId: z.string().min(1).max(200),
  outputId: z.string().uuid(),
  outputRevision: z.literal(1),
  contextPackageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['ask', 'agent', 'auto']),
  label: z.string().trim().min(1).max(160),
  additionalInstructions: z.string().max(6000),
});
export type OutputContributorBinding = z.infer<typeof OutputContributorBindingSchema>;

export interface SessionOutputReference {
  outputId: string;
  sessionId: string;
  title: string;
  revision: 1;
  kind: 'inline_draft';
  durability: 'reference_registered';
  label: 'In conversation';
  sourceAvailability: 'available' | 'unavailable';
  source: SessionOutputSource & { sessionId: string };
  provenance: SymposiumProvenance | null;
  createdAt: number;
}
export interface SessionOutputCandidate {
  source: SessionOutputSource;
  content: string;
}
