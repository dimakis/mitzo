import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileQuoteCatalog } from '../quote-catalog.js';

const drafts = JSON.parse(
  readFileSync(new URL('../../content/quotes/drafts.json', import.meta.url), 'utf8'),
);
const catalog = JSON.parse(
  readFileSync(new URL('../../content/quotes/catalog.json', import.meta.url), 'utf8'),
);
it('ships at least twenty distinct, short, reviewed quotations across at least ten authors', () => {
  expect(catalog.length).toBeGreaterThanOrEqual(20);
  expect(new Set(catalog.map((quote: { id: string }) => quote.id)).size).toBe(catalog.length);
  expect(
    new Set(catalog.map((quote: { author: string }) => quote.author)).size,
  ).toBeGreaterThanOrEqual(10);
  for (const quote of catalog) expect(quote.text.trim().split(/\s+/).length).toBeLessThan(20);
  expect(catalog.some((quote: { author: string }) => quote.author === 'Mary Wollstonecraft')).toBe(
    true,
  );
  expect(catalog.some((quote: { author: string }) => quote.author === 'Confucius')).toBe(true);
  expect(catalog.some((quote: { author: string }) => quote.author.startsWith('Dhammapada'))).toBe(
    true,
  );
});
it('publishes only verified entries with dated primary-edition evidence and an exact fresh build', () => {
  expect(catalog).toEqual(compileQuoteCatalog(drafts));
  expect(drafts).toHaveLength(catalog.length);
  for (const draft of drafts) {
    expect(draft.verification).toBe('verified');
    expect(draft.evidence).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(draft.evidence).toMatch(/public.domain/i);
    expect(draft.sourceUrl).toMatch(/^https:\/\//);
    expect(draft.work).toBeTruthy();
    expect(draft.translation).toBeTruthy();
    expect(draft.explanation).toBeTruthy();
    expect(draft.example).toBeTruthy();
    expect(draft.biography).toBeTruthy();
  }
});
