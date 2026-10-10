import { z } from 'zod';

const privateMaterial = [
  /\/(?:Users|home|sandbox|tmp|private\/tmp|private\/var\/folders)\//i,
  /[A-Za-z]:\\(?:Users|Temp)\\/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/i,
  /\b(?:Bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/i,
  /\b(?:api[_ -]?key|password|client[_ -]?secret)\s*[:=]/i,
  /\[(?:conversation|chat) transcript\]/i,
];

export const ContextPackIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const ContextPackPinSchema = z.strictObject({
  id: ContextPackIdSchema,
  revision: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ContextPackPin = z.infer<typeof ContextPackPinSchema>;
const path = z
  .string()
  .max(240)
  .refine(
    (value) =>
      value.endsWith('.md') &&
      /^[\p{L}\p{N}_ /().-]+$/u.test(value) &&
      value
        .split('/')
        .every((part) => part && part.trim() === part && !part.startsWith('.') && part !== '..'),
    'Use a relative Knowledge Markdown document reference',
  );
export const ContextPackDocumentSchema = z.strictObject({
  path,
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  mode: z.enum(['required', 'prioritized', 'excluded']),
  headings: z.array(z.array(z.string().trim().min(1).max(120)).min(1).max(8)).max(20),
  priority: z.number().int().min(0).max(100),
});
export type ContextPackDocument = z.infer<typeof ContextPackDocumentSchema>;
/** Portable curation only: host enrollment owns source access and provider admission. */
export const ContextPackDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    id: ContextPackIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    tokenBudget: z.number().int().min(256).max(32000),
    documents: z.array(ContextPackDocumentSchema).min(1).max(100),
    retrievalGuidance: z.string().max(8000),
    rationale: z.string().max(4000).optional(),
  })
  .superRefine((pack, ctx) => {
    const guidance = [
      pack.name,
      pack.description,
      pack.retrievalGuidance,
      pack.rationale ?? '',
      ...pack.documents.flatMap((doc) => doc.headings.flat()),
    ];
    if (guidance.some((text) => privateMaterial.some((pattern) => pattern.test(text))))
      ctx.addIssue({
        code: 'custom',
        message:
          'Portable context packs cannot contain credentials, transcript dumps or machine paths',
      });
    for (let i = 0; i < pack.documents.length; i++) {
      const doc = pack.documents[i]!;
      const keys = doc.headings.map((heading) =>
        JSON.stringify(heading.map((part) => part.toLowerCase())),
      );
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate section selectors' });
      for (const other of pack.documents.slice(0, i)) {
        if (other.path !== doc.path) continue;
        if (other.revision !== doc.revision)
          ctx.addIssue({ code: 'custom', message: 'A document must use one accepted revision' });
        const overlaps =
          !other.headings.length ||
          !doc.headings.length ||
          other.headings.some((a) =>
            doc.headings.some(
              (b) =>
                a.every((part, j) => b[j]?.toLowerCase() === part.toLowerCase()) ||
                b.every((part, j) => a[j]?.toLowerCase() === part.toLowerCase()),
            ),
          );
        if (overlaps)
          ctx.addIssue({ code: 'custom', message: 'Duplicate or conflicting document selection' });
      }
    }
  });
export type ContextPackDefinition = z.infer<typeof ContextPackDefinitionSchema>;
export const PublishedContextPackSchema = z
  .strictObject({
    id: ContextPackIdSchema,
    revision: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    definition: ContextPackDefinitionSchema,
    publishedAt: z.iso.datetime(),
  })
  .refine((pack) => pack.id === pack.definition.id, 'Pack identity mismatch');
export type PublishedContextPack = z.infer<typeof PublishedContextPackSchema>;
export const ContextPackDraftSchema = z.strictObject({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative(),
  definition: ContextPackDefinitionSchema,
  updatedAt: z.iso.datetime(),
  state: z.enum(['draft', 'published']),
  publishedRevision: z.number().int().positive().optional(),
});
export type ContextPackDraft = z.infer<typeof ContextPackDraftSchema>;
