import { z } from 'zod';

/** Existing canonical Telos creation contract, shared with reviewed capture.
 * Canonical persistence and milestone creation remain with the MGMT owner.
 */
export const TelosOutcomeContextHintsSchema = z.object({
  repos: z.array(z.string()).optional().default([]),
  paths: z.array(z.string()).optional().default([]),
  issues: z.array(z.string()).optional().default([]),
  docIds: z.array(z.string()).optional().default([]),
  people: z.array(z.string()).optional().default([]),
  jiraKeys: z.array(z.string()).optional().default([]),
  keywords: z.array(z.string()).optional().default([]),
  taskHint: z.string().optional().default(''),
  sessionIds: z.array(z.string()).optional().default([]),
});
export const TelosOutcomeLinkSchema = z.object({
  type: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().optional().default(''),
});
export const TelosOutcomeCreateBodySchema = z.object({
  summary: z.string().trim().min(1).max(160),
  intent: z.string().trim().min(1).max(2000),
  rationale: z.string().trim().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  milestones: z.array(z.string().trim().min(1).max(500)).min(1).max(24),
  profile: z.string().trim().min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(300),
  contextHints: TelosOutcomeContextHintsSchema.partial().optional(),
  links: z.array(TelosOutcomeLinkSchema).max(24).optional(),
});
export const TelosOutcomeProposalSchema = TelosOutcomeCreateBodySchema.omit({
  idempotencyKey: true,
}).strict();
export type TelosOutcomeProposal = z.infer<typeof TelosOutcomeProposalSchema>;
export type TelosOutcomeCreation = z.infer<typeof TelosOutcomeCreateBodySchema>;
