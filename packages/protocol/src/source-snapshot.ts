import { z } from 'zod';
import { AgentLibraryEditableDefinitionSchema } from './agent-library-editable.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= bytes,
      'Source exceeds its byte limit',
    );

/** Editable fields remain reference data; a draft need not be publishable yet. */
export const AgentLibrarySourceContentSchema = z.strictObject({
  version: z.literal(1),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('published'),
      profileId: z.string().min(1).max(128),
      revision: z.number().int().positive(),
      contentHash: hash,
    }),
    z.strictObject({
      kind: z.literal('draft'),
      profileId: z.string().min(1).max(128),
      baseRevision: z.number().int().nonnegative(),
      draftVersion: z.number().int().positive().nullable(),
      expectedVersion: z.number().int().nonnegative(),
    }),
  ]),
  definition: AgentLibraryEditableDefinitionSchema,
  reviewedContext: boundedText(1024 * 1024).optional(),
});
export type AgentLibrarySourceContent = z.infer<typeof AgentLibrarySourceContentSchema>;

export const AgentLibrarySourceSnapshotSchema = z.strictObject({
  kind: z.literal('agent-library'),
  revision: hash,
  content: boundedText(2 * 1024 * 1024).refine((content) => {
    try {
      return AgentLibrarySourceContentSchema.safeParse(JSON.parse(content)).success;
    } catch {
      return false;
    }
  }, 'Invalid Agent Library source content'),
});

/** Inline saved references are distinct from configured context block names. */
const BriefingSourceSnapshotSchema = z
  .object({
    kind: z.literal('briefing'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
      }, 'Invalid source date'),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    content: z
      .string()
      .max(2 * 1024 * 1024)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 2 * 1024 * 1024,
        'Source exceeds 2 MiB',
      ),
  })
  .strict();
export const SourceSnapshotSchema = z.discriminatedUnion('kind', [
  BriefingSourceSnapshotSchema,
  AgentLibrarySourceSnapshotSchema,
]);
export const SourceSnapshotsSchema = z.array(SourceSnapshotSchema).max(1);
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
