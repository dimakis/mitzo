/**
 * Smoke test: verify contexgin is importable and exports the expected API.
 * This test exists to catch broken links or missing builds early.
 */
import { describe, it, expect, beforeAll } from 'vitest';

describe('contexgin dependency', () => {
  let contexgin: typeof import('contexgin') extends Promise<infer T> ? T : never;

  beforeAll(async () => {
    contexgin = await import('contexgin');
  });

  it('exports compile and discoverSources', () => {
    expect(typeof contexgin.compile).toBe('function');
    expect(typeof contexgin.discoverSources).toBe('function');
  });

  it('compile runs without throwing on trivial input', async () => {
    const result = await contexgin.compile({ sources: [] });
    expect(result).toBeDefined();
  });

  it('exports integrity functions', () => {
    expect(typeof contexgin.extractClaims).toBe('function');
    expect(typeof contexgin.validateAll).toBe('function');
  });

  it('exports navigation functions', () => {
    expect(typeof contexgin.indexConstitutions).toBe('function');
    expect(typeof contexgin.generateReadingList).toBe('function');
  });
});
