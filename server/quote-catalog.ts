import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { PhilosophyQuote } from '@mitzo/protocol';
import { quoteSchema } from './home-store.js';

const draftSchema = quoteSchema.extend({
  verification: z.enum(['draft', 'verified']),
  evidence: z.string().max(5000),
});
export function compileQuoteCatalog(input: unknown): PhilosophyQuote[] {
  const drafts = z.array(draftSchema).max(10000).parse(input);
  const admitted = drafts.filter((entry) => entry.verification === 'verified');
  if (!admitted.length || admitted.some((entry) => !entry.evidence.trim()))
    throw new Error('A verified catalogue with source evidence is required');
  const catalog = admitted.map(
    ({ verification: _verification, evidence: _evidence, ...quote }) => quote,
  );
  if (new Set(catalog.map((quote) => quote.id)).size !== catalog.length)
    throw new Error('Duplicate quote IDs');
  return catalog;
}

let cached: PhilosophyQuote[] | undefined;
export function readQuoteCatalog(): PhilosophyQuote[] {
  return (cached ??= z
    .array(quoteSchema)
    .min(1)
    .max(10000)
    .parse(
      JSON.parse(readFileSync(new URL('../content/quotes/catalog.json', import.meta.url), 'utf8')),
    ));
}
