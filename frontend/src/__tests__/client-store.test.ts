import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Structural test: client-store uses model-preference sync at module scope,
// which accesses localStorage. The `typeof window` guard prevents crashes
// when the module is imported in a non-browser context (e.g. Vitest server tests).
describe('client-store window guard', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(join(import.meta.dirname, '..', 'client-store.ts'), 'utf-8');
  });

  it('guards model preference sync with typeof window check', () => {
    expect(source).toContain("typeof window !== 'undefined'");
    expect(source).toContain('getPreferredModel()');
  });
});
