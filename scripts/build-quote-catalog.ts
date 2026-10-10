import { readFileSync, writeFileSync } from 'node:fs';
import { compileQuoteCatalog } from '../server/quote-catalog.js';

const source = new URL('../content/quotes/drafts.json', import.meta.url);
const output = new URL('../content/quotes/catalog.json', import.meta.url);
const compiled =
  JSON.stringify(compileQuoteCatalog(JSON.parse(readFileSync(source, 'utf8'))), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== compiled)
    throw new Error('Quote catalogue is stale. Run npm run quotes:build and review the diff.');
} else writeFileSync(output, compiled);
console.log(
  process.argv.includes('--check')
    ? 'Quote catalogue verified.'
    : 'Built the verified quote catalogue.',
);
