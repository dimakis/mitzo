/**
 * Smoke test: verify contexgin is importable and exports the expected API.
 * This test exists to catch broken links or missing builds early.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';

describe('contexgin dependency', () => {
  let contexgin: Awaited<typeof import('contexgin')>;

  beforeAll(async () => {
    contexgin = await import('contexgin');
  });

  it('exports compile and discoverSources', () => {
    expect(typeof contexgin.compile).toBe('function');
    expect(typeof contexgin.discoverSources).toBe('function');
  });

  it('compile runs without throwing on a minimal workspace', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'contexgin-smoke-'));
    writeFileSync(join(tmp, 'CLAUDE.md'), '# Test\nMinimal workspace.');
    try {
      const result = await contexgin.compile({ workspaceRoot: tmp, tokenBudget: 1000 });
      expect(result).toBeDefined();
      expect(result.bootPayload).toBeDefined();
      expect(result.bootTokens).toBeLessThanOrEqual(1000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
