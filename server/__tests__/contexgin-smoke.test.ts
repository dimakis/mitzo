/**
 * Smoke test: verify contexgin is importable and exports the expected API.
 * This test exists to catch broken links or missing builds early.
 */
import { describe, it, expect } from 'vitest';

describe('contexgin dependency', () => {
  it('exports compile and discoverSources', async () => {
    const contexgin = await import('contexgin');
    expect(typeof contexgin.compile).toBe('function');
    expect(typeof contexgin.discoverSources).toBe('function');
  });

  it('exports integrity functions', async () => {
    const contexgin = await import('contexgin');
    expect(typeof contexgin.extractClaims).toBe('function');
    expect(typeof contexgin.validateAll).toBe('function');
  });

  it('exports navigation functions', async () => {
    const contexgin = await import('contexgin');
    expect(typeof contexgin.indexConstitutions).toBe('function');
    expect(typeof contexgin.generateReadingList).toBe('function');
  });
});
