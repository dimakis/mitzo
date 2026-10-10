import { z } from 'zod';

/** Inline saved references are distinct from configured context block names. */
export const SourceSnapshotSchema = z
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
export const SourceSnapshotsSchema = z.array(SourceSnapshotSchema).max(1);
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
